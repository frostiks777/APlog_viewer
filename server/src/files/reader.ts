import { open, stat, type FileHandle } from 'node:fs/promises';
import { decode, detectEncoding, encodingByExtension, type Encoding } from './encoding.js';
import { MAX_PAGE_BYTES, READ_CHUNK_BYTES } from '../config.js';

const NEWLINE = 0x0a;
const CARRIAGE = 0x0d;
const PREV_LINE_WINDOW = 64 * 1024;
const PREV_LINE_MAX_WINDOWS = 64;

export interface LogLine {
  /** Байтовое смещение начала строки в файле — стабильный адрес строки. */
  offset: number;
  text: string;
}

export interface LogPage {
  lines: LogLine[];
  /** Смещение, с которого читается следующая страница. */
  endOffset: number;
  /** Достигнут ли конец файла на момент чтения. */
  eof: boolean;
  size: number;
  mtimeMs: number;
  encoding: Encoding;
}

export interface FileIdentity {
  /** Серийный номер тома: вместе с ino переживает переименование при ротации. */
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
}

function lastNewline(buffer: Buffer, from = 0, to = buffer.length): number {
  for (let i = to - 1; i >= from; i -= 1) {
    if (buffer[i] === NEWLINE) return i;
  }
  return -1;
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  for (let i = 0; i < buffer.length; i += 1) if (buffer[i] === NEWLINE) count += 1;
  return count;
}

/**
 * Открытый лог. Держит ОДИН хендл и читает только запрошенные окна — файл целиком
 * в память не попадает никогда (техника Lister: 64 КБ в памяти, остальное по скроллу).
 */
export class LogFile {
  private handle: FileHandle;
  private identity: FileIdentity;
  private closed = false;
  private lastStatMs = Date.now();

  encoding: Encoding;
  /** Кодировка выбрана пользователем и не должна переопределяться автодетектом. */
  readonly encodingLocked: boolean;

  private constructor(
    readonly path: string,
    handle: FileHandle,
    identity: FileIdentity,
    encoding: Encoding,
    encodingLocked: boolean,
  ) {
    this.handle = handle;
    this.identity = identity;
    this.encoding = encoding;
    this.encodingLocked = encodingLocked;
  }

  static async open(path: string, encodingOverride?: Encoding): Promise<LogFile> {
    const [handle, stats] = await Promise.all([open(path, 'r'), stat(path, { bigint: true })]);
    const identity = toIdentity(stats);
    const encoding = encodingOverride ?? (await LogFile.pickEncoding(path, identity.size));
    return new LogFile(path, handle, identity, encoding, Boolean(encodingOverride));
  }

  private static async pickEncoding(path: string, size: number): Promise<Encoding> {
    if (size === 0) return encodingByExtension(path) ?? 'utf-8';
    return detectEncoding(path);
  }

  get size(): number {
    return this.identity.size;
  }

  get mtimeMs(): number {
    return this.identity.mtimeMs;
  }

  get id(): string {
    return `${this.identity.dev}:${this.identity.ino}`;
  }

  /**
   * Обновляет размер и проверяет, что путь всё ещё указывает на тот же файл.
   * Ночная ротация (portal.log -> portal.0.log + новый portal.log) даёт другой ino —
   * тогда хендл переоткрывается на новый файл.
   *
   * stat по SMB стоит десятки-сотни миллисекунд, поэтому для листания страниц он
   * троттлится: цена — устаревший eof на пару секунд, которую тут же исправит следующий stat.
   */
  async refresh(force = false, minIntervalMs = 2000): Promise<{ rotated: boolean; grown: boolean }> {
    const now = Date.now();
    if (!force && now - this.lastStatMs < minIntervalMs) {
      return { rotated: false, grown: false };
    }
    this.lastStatMs = now;

    const stats = await stat(this.path, { bigint: true });
    const next = toIdentity(stats);
    const rotated = next.dev !== this.identity.dev || next.ino !== this.identity.ino;
    const grown = next.size !== this.identity.size;

    if (rotated) {
      await this.handle.close();
      this.handle = await open(this.path, 'r');
      if (!this.encodingLocked) this.encoding = await LogFile.pickEncoding(this.path, next.size);
    }
    this.identity = next;
    return { rotated, grown };
  }

  async identityNow(): Promise<FileIdentity> {
    return this.identity;
  }

  /** Страница строк, начиная со смещения начала строки. */
  async readPage(byteOffset: number, maxLines: number): Promise<LogPage> {
    await this.refresh(false);
    const offset = Math.max(0, Math.min(byteOffset, this.identity.size));
    if (offset >= this.identity.size) {
      return this.page([], offset, true);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let newlines = 0;
    let position = offset;
    let complete = false;

    while (position < this.identity.size && total < MAX_PAGE_BYTES) {
      const length = Math.min(
        READ_CHUNK_BYTES,
        this.identity.size - position,
        MAX_PAGE_BYTES - total,
      );
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await this.handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;

      const chunk = buffer.subarray(0, bytesRead);
      chunks.push(chunk);
      total += bytesRead;
      position += bytesRead;

      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] === NEWLINE) {
          newlines += 1;
          if (newlines >= maxLines) {
            complete = true;
            break;
          }
        }
      }
      if (complete) break;
    }

    const buffer = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, total);
    let cut = buffer.length;
    let nextOffset = offset + buffer.length;

    if (complete) {
      let seen = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        if (buffer[i] === NEWLINE) {
          seen += 1;
          if (seen === maxLines) {
            cut = i + 1;
            nextOffset = offset + cut;
            break;
          }
        }
      }
    } else if (position < this.identity.size) {
      // Упёрлись в лимит байт: отдаём только полные строки, иначе следующая страница
      // начнётся с середины строки и склеит её дважды.
      const last = lastNewline(buffer);
      if (last >= 0) {
        cut = last + 1;
        nextOffset = offset + cut;
      }
    }

    const lines = splitLines(buffer, cut, offset, this.encoding);
    return this.page(lines, nextOffset, nextOffset >= this.identity.size);
  }

  /**
   * Чтение хвоста: только завершённые строки. Неполная последняя строка не отдаётся,
   * иначе при следующем опросе она придёт второй раз. За один вызов отдаём не больше
   * maxLines — иначе после простоя клиент получит десятки тысяч строк разом.
   */
  async readTail(fromOffset: number, maxLines = 2000): Promise<LogPage> {
    await this.refresh(true);
    const offset = Math.max(0, Math.min(fromOffset, this.identity.size));
    if (offset >= this.identity.size) {
      return this.page([], offset, true);
    }

    const limited = Math.min(this.identity.size - offset, MAX_PAGE_BYTES);
    const buffer = Buffer.allocUnsafe(limited);
    const { bytesRead } = await this.handle.read(buffer, 0, limited, offset);
    const chunk = buffer.subarray(0, bytesRead);

    let cut = -1;
    let seen = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk[i] !== NEWLINE) continue;
      seen += 1;
      if (seen >= maxLines) {
        cut = i + 1;
        break;
      }
    }
    if (cut < 0) cut = lastNewline(chunk) + 1;
    if (cut <= 0) return this.page([], offset, true);

    const lines = splitLines(chunk, cut, offset, this.encoding);
    const endOffset = offset + cut;
    return this.page(lines, endOffset, endOffset >= this.identity.size);
  }

  /**
   * Страница строк ПЕРЕД смещением. Читаем назад блоками, пока не наберём maxLines,
   * затем отдаём ровно те строки, которые ещё не показаны клиенту (offset < byteOffset).
   */
  async pageBefore(byteOffset: number, maxLines: number): Promise<LogPage> {
    await this.refresh(false);
    const end = Math.max(0, Math.min(byteOffset, this.identity.size));
    if (end <= 0) return this.page([], 0, false);

    let start = Math.max(0, end - READ_CHUNK_BYTES);
    const chunks: Buffer[] = [await this.readRange(start, end - start)];
    let newlines = countNewlines(chunks[0] as Buffer);

    while (newlines <= maxLines && start > 0 && end - start < MAX_PAGE_BYTES) {
      const nextStart = Math.max(0, start - READ_CHUNK_BYTES);
      const chunk = await this.readRange(nextStart, start - nextStart);
      chunks.unshift(chunk);
      newlines += countNewlines(chunk);
      start = nextStart;
    }

    const buffer = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
    const starts: number[] = [];
    if (start === 0) starts.push(0);
    for (let i = 0; i < buffer.length - 1; i += 1) {
      if (buffer[i] === NEWLINE) starts.push(start + i + 1);
    }
    if (starts.length === 0) return this.page([], 0, false);

    const from = starts.length > maxLines ? (starts[starts.length - maxLines] as number) : (starts[0] as number);
    const page = await this.readPage(from, maxLines);
    const lines = page.lines.filter((line) => line.offset < end);
    return { ...page, lines };
  }

  private async readRange(position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  }

  /** Начало предыдущей строки — для прокрутки вверх и поиска назад. */
  async prevLineStart(offset: number): Promise<number | null> {
    if (offset <= 0) return null;
    let end = Math.min(offset, this.identity.size);
    for (let attempt = 0; attempt < PREV_LINE_MAX_WINDOWS && end > 0; attempt += 1) {
      const start = Math.max(0, end - PREV_LINE_WINDOW);
      const span = end - start;
      const buffer = Buffer.allocUnsafe(span);
      const { bytesRead } = await this.handle.read(buffer, 0, span, start);
      const view = buffer.subarray(0, bytesRead);
      const idx = lastNewline(view, 0, bytesRead);
      if (idx >= 0) {
        const candidate = start + idx + 1;
        return candidate < offset ? candidate : Math.max(0, candidate - 1);
      }
      if (start === 0) return 0;
      end = start;
    }
    return 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }

  private page(lines: LogLine[], endOffset: number, eof: boolean): LogPage {
    return {
      lines,
      endOffset,
      eof,
      size: this.identity.size,
      mtimeMs: this.identity.mtimeMs,
      encoding: this.encoding,
    };
  }
}

function splitLines(buffer: Buffer, cut: number, baseOffset: number, encoding: Encoding): LogLine[] {
  const lines: LogLine[] = [];
  let start = 0;
  for (let i = 0; i < cut; i += 1) {
    if (buffer[i] !== NEWLINE) continue;
    let end = i;
    if (end > start && buffer[end - 1] === CARRIAGE) end -= 1;
    lines.push({ offset: baseOffset + start, text: decode(buffer.subarray(start, end), encoding) });
    start = i + 1;
  }
  if (start < cut) {
    lines.push({ offset: baseOffset + start, text: decode(buffer.subarray(start, cut), encoding) });
  }
  return lines;
}

function toIdentity(stats: { dev: bigint; ino: bigint; size: bigint; mtimeMs: number | bigint }): FileIdentity {
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
  };
}

/** Кэш открытых файлов: один хендл на путь, закрытие по простою. */
export class LogFilePool {
  private readonly files = new Map<string, { file: LogFile; usedAt: number }>();

  constructor(private readonly idleMs: number) {}

  async get(path: string, encoding?: Encoding): Promise<LogFile> {
    const cached = this.files.get(path);
    if (cached) {
      if (encoding && !cached.file.encodingLocked) cached.file.encoding = encoding;
      cached.usedAt = Date.now();
      return cached.file;
    }
    const file = await LogFile.open(path, encoding);
    this.files.set(path, { file, usedAt: Date.now() });
    return file;
  }

  async closeIdle(now = Date.now()): Promise<void> {
    const victims: string[] = [];
    for (const [path, entry] of this.files) {
      if (now - entry.usedAt > this.idleMs) victims.push(path);
    }
    await Promise.all(
      victims.map(async (path) => {
        const entry = this.files.get(path);
        if (!entry) return;
        this.files.delete(path);
        await entry.file.close();
      }),
    );
  }

  async closeAll(): Promise<void> {
    const entries = [...this.files.values()];
    this.files.clear();
    await Promise.all(entries.map((entry) => entry.file.close()));
  }
}
