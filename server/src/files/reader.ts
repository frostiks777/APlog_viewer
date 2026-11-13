import { open, stat, type FileHandle } from 'node:fs/promises';
import { detectEncoding, encodingByExtension, type Encoding } from './encoding.js';
import { collectLineEnds, decodeLines } from './lines.js';
import { MAX_PAGE_BYTES, READ_CHUNK_BYTES } from '../config.js';

const PREV_LINE_WINDOW = 64 * 1024;
const PREV_LINE_MAX_WINDOWS = 64;

export interface LogLine {
  /** Байтовое смещение начала строки в файле — стабильный адрес строки. */
  offset: number;
  text: string;
}

/**
 * Что случилось с файлом между опросами. Нужен tail-клиенту, чтобы не склеивать
 * строки разных поколений файла после ротации или усечения.
 */
export type FileEvent = 'ok' | 'rotated' | 'truncated';

export interface LogPage {
  lines: LogLine[];
  /** Смещение, с которого читается следующая страница. */
  endOffset: number;
  /** Достигнут ли конец файла на момент чтения. */
  eof: boolean;
  size: number;
  mtimeMs: number;
  encoding: Encoding;
  event: FileEvent;
}

export interface FileIdentity {
  /** Серийный номер тома: вместе с ino переживает переименование при ротации. */
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
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
    const handle = await open(path, 'r');
    try {
      const stats = await stat(path, { bigint: true });
      const identity = toIdentity(stats);
      const encoding = encodingOverride ?? (await LogFile.pickEncoding(path, identity.size));
      return new LogFile(path, handle, identity, encoding, Boolean(encodingOverride));
    } catch (error) {
      // Иначе FileHandle станет недостижимым, а Node 26 падает на его сборке мусора.
      await handle.close().catch(() => undefined);
      throw error;
    }
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
  async refresh(force = false, minIntervalMs = 2000): Promise<FileEvent> {
    const now = Date.now();
    if (!force && now - this.lastStatMs < minIntervalMs) return 'ok';
    this.lastStatMs = now;

    const previous = this.identity;
    const stats = await stat(this.path, { bigint: true });
    const next = toIdentity(stats);
    const rotated = next.dev !== previous.dev || next.ino !== previous.ino;
    const truncated = !rotated && next.size < previous.size;

    if (rotated) {
      await this.handle.close();
      this.handle = await open(this.path, 'r');
      if (!this.encodingLocked) this.encoding = await LogFile.pickEncoding(this.path, next.size);
    }
    this.identity = next;
    return rotated ? 'rotated' : truncated ? 'truncated' : 'ok';
  }

  async identityNow(): Promise<FileIdentity> {
    return this.identity;
  }

  /** Страница строк, начиная со смещения начала строки. */
  async readPage(byteOffset: number, maxLines: number): Promise<LogPage> {
    const event = await this.refresh(false);
    return { ...(await this.pageFrom(byteOffset, maxLines)), event };
  }

  private async pageFrom(byteOffset: number, maxLines: number): Promise<LogPage> {
    const offset = Math.max(0, Math.min(byteOffset, this.identity.size));
    if (offset >= this.identity.size) return this.page([], offset, true);

    const chunks: Buffer[] = [];
    let total = 0;
    let newlines = 0;
    let position = offset;
    let complete = false;

    while (position < this.identity.size && total < MAX_PAGE_BYTES) {
      const length = Math.min(READ_CHUNK_BYTES, this.identity.size - position, MAX_PAGE_BYTES - total);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await this.handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;

      const chunk = buffer.subarray(0, bytesRead);
      chunks.push(chunk);
      total += bytesRead;
      position += bytesRead;

      newlines += collectLineEnds(chunk, this.encoding).length;
      if (newlines >= maxLines) {
        complete = true;
        break;
      }
    }

    const buffer = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, total);
    const ends = collectLineEnds(buffer, this.encoding, complete ? maxLines : Number.POSITIVE_INFINITY);

    let cut = buffer.length;
    let nextOffset = offset + buffer.length;

    if (complete && ends.length >= maxLines) {
      cut = ends[maxLines - 1] as number;
      nextOffset = offset + cut;
    } else if (position < this.identity.size) {
      // Упёрлись в лимит байт: отдаём только полные строки, иначе следующая страница
      // начнётся с середины строки и склеит её дважды.
      const lastEnd = ends[ends.length - 1];
      if (lastEnd !== undefined) {
        cut = lastEnd;
        nextOffset = offset + cut;
      }
    }

    const lines = decodeLines(buffer, cut, offset, this.encoding);
    return this.page(lines, nextOffset, nextOffset >= this.identity.size);
  }

  /**
   * Последняя страница файла: открываем лог сразу в конце, как это делает хвостовой
   * просмотр. Возвращает последние maxLines строк, включая незавершённую последнюю.
   */
  async readLastPage(maxLines: number): Promise<LogPage> {
    // «В конец» — явное действие: стат обязателен, иначе дописанные за последние
    // секунды строки не попадут на страницу, а номер её первой строки разойдётся с индексом.
    const event = await this.refresh(true);
    const size = this.identity.size;
    if (size === 0) return { ...this.page([], 0, true), event };

    const starts: number[] = [];
    let end = size;
    while (starts.length <= maxLines && end > 0 && size - end < MAX_PAGE_BYTES) {
      const start = Math.max(0, end - READ_CHUNK_BYTES);
      const chunk = await this.readRange(start, end - start);
      const ends = collectLineEnds(chunk, this.encoding);
      for (let i = ends.length - 1; i >= 0; i -= 1) starts.push(start + (ends[i] as number));
      end = start;
    }

    // Позиция size — не начало строки, а «пустая строка» после последнего перевода.
    const clean = starts.filter((offset) => offset < size).sort((a, b) => a - b);
    const from = clean.length > maxLines ? (clean[clean.length - maxLines] as number) : 0;
    return { ...(await this.pageFrom(from, maxLines)), event };
  }

  /**
   * Страница строк ПЕРЕД смещением. Читаем назад блоками, пока не наберём maxLines,
   * затем отдаём ровно те строки, которые ещё не показаны клиенту (offset < byteOffset).
   */
  async pageBefore(byteOffset: number, maxLines: number): Promise<LogPage> {
    const event = await this.refresh(false);
    const end = Math.max(0, Math.min(byteOffset, this.identity.size));
    if (end <= 0) return { ...this.page([], 0, false), event };

    let start = Math.max(0, end - READ_CHUNK_BYTES);
    const chunks: Buffer[] = [await this.readRange(start, end - start)];
    let newlines = collectLineEnds(chunks[0] as Buffer, this.encoding).length;

    while (newlines <= maxLines && start > 0 && end - start < MAX_PAGE_BYTES) {
      const nextStart = Math.max(0, start - READ_CHUNK_BYTES);
      const chunk = await this.readRange(nextStart, start - nextStart);
      chunks.unshift(chunk);
      newlines += collectLineEnds(chunk, this.encoding).length;
      start = nextStart;
    }

    const buffer = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
    const starts: number[] = [];
    if (start === 0) starts.push(0);
    for (const endIndex of collectLineEnds(buffer, this.encoding)) {
      if (start + endIndex < end) starts.push(start + endIndex);
    }
    if (starts.length === 0) return { ...this.page([], 0, false), event };

    const from = starts.length > maxLines ? (starts[starts.length - maxLines] as number) : (starts[0] as number);
    const page = await this.pageFrom(from, maxLines);
    const lines = page.lines.filter((line) => line.offset < end);
    return { ...page, lines, event };
  }

  private async readRange(position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  }

  /**
   * Чтение хвоста: только завершённые строки. Неполная последняя строка не отдаётся,
   * иначе при следующем опросе она придёт второй раз. За один вызов отдаём не больше
   * maxLines — иначе после простоя клиент получит десятки тысяч строк разом.
   */
  async readTail(fromOffset: number, maxLines = 2000): Promise<LogPage> {
    const event = await this.refresh(true);
    const offset = Math.max(0, Math.min(fromOffset, this.identity.size));
    if (offset >= this.identity.size) return { ...this.page([], offset, true), event };

    const limited = Math.min(this.identity.size - offset, MAX_PAGE_BYTES);
    const buffer = Buffer.allocUnsafe(limited);
    const { bytesRead } = await this.handle.read(buffer, 0, limited, offset);
    const chunk = buffer.subarray(0, bytesRead);
    const ends = collectLineEnds(chunk, this.encoding, maxLines);

    let cut = ends[ends.length - 1] ?? -1;
    if (ends.length < maxLines && cut < 0) return { ...this.page([], offset, true), event };
    if (ends.length >= maxLines) cut = ends[maxLines - 1] as number;
    if (cut <= 0) return { ...this.page([], offset, true), event };

    const lines = decodeLines(chunk, cut, offset, this.encoding);
    const endOffset = offset + cut;
    return { ...this.page(lines, endOffset, endOffset >= this.identity.size), event };
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
      const ends = collectLineEnds(view, this.encoding);
      const last = ends[ends.length - 1];
      if (last !== undefined) {
        const candidate = start + last;
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
      event: 'ok',
    };
  }
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
  /** Последняя известная идентичность по пути — чтобы замечать ротацию между опросами. */
  private readonly identities = new Map<string, FileIdentity>();
  /**
   * Открытия в процессе. Два одновременных запроса к холодному пути не должны открыть
   * файл дважды: второй результат перезаписал бы первый в кэше, а первый FileHandle
   * остался бы без close() — Node 26 на этом падает.
   */
  private readonly opening = new Map<string, Promise<LogFile>>();

  constructor(private readonly idleMs: number) {}

  recallIdentity(path: string): FileIdentity | undefined {
    return this.identities.get(path);
  }

  rememberIdentity(path: string, identity: FileIdentity): void {
    this.identities.set(path, identity);
  }

  async get(path: string, encoding?: Encoding): Promise<LogFile> {
    const cached = this.files.get(path);
    if (cached) {
      if (encoding && !cached.file.encodingLocked) cached.file.encoding = encoding;
      cached.usedAt = Date.now();
      return cached.file;
    }

    const pending = this.opening.get(path);
    if (pending) {
      const file = await pending;
      if (encoding && !file.encodingLocked) file.encoding = encoding;
      const entry = this.files.get(path);
      if (entry) entry.usedAt = Date.now();
      return file;
    }

    const promise = LogFile.open(path, encoding).then((file) => {
      this.files.set(path, { file, usedAt: Date.now() });
      return file;
    });
    this.opening.set(path, promise);
    try {
      return await promise;
    } finally {
      // Успех или ошибка — следующий запрос должен начать новое открытие.
      this.opening.delete(path);
    }
  }

  async closeIdle(now = Date.now()): Promise<void> {
    for (const [path, entry] of this.files) {
      if (now - entry.usedAt > this.idleMs) await this.release(path);
    }
  }

  /**
   * Закрыть и выкинуть хендл. Нужно для tail: держать файл открытым нельзя —
   * ночная ротация через rename упадёт у писателя с EPERM, если мы не отпустили файл.
   */
  async release(path: string): Promise<void> {
    const entry = this.files.get(path);
    if (!entry) return;
    this.files.delete(path);
    this.identities.set(path, await entry.file.identityNow());
    await entry.file.close();
  }

  async closeAll(): Promise<void> {
    const entries = [...this.files.values()];
    this.files.clear();
    await Promise.all(entries.map((entry) => entry.file.close()));
  }
}
