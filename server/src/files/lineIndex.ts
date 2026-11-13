import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR, LINE_INDEX_CHUNK_BYTES, LINE_INDEX_SAVE_BYTES, LINE_INDEX_STEP } from '../config.js';
import type { Encoding } from './encoding.js';
import { collectLineEnds } from './lines.js';

/**
 * Всё, что индексу нужно от файла. Хендл и путь пула сюда не входят: индекс строит
 * собственное чтение, иначе `tail` закрыл бы файл посреди достройки.
 */
export interface LineIndexInput {
  path: string;
  /** Идентичность файла `dev:ino`: переживает переименование при ротации. */
  id: string;
  encoding: Encoding;
  size: number;
}

export interface LineIndexStatus {
  state: 'idle' | 'building' | 'ready' | 'error';
  /** Сколько начал строк известно: столько строк можно пронумеровать точно. */
  knownLines: number;
  scannedTo: number;
  size: number;
  step: number;
  complete: boolean;
  encoding: Encoding;
  /** Индекс загружен с диска, а не построен в этом процессе. */
  fromCache: boolean;
  error: string | null;
}

interface CacheFile {
  version: 1;
  id: string;
  encoding: Encoding;
  step: number;
  path: string;
  scannedTo: number;
  newlines: number;
  tailNewline: boolean;
  /** marks[k] — смещение начала строки 1 + k * step. */
  marks: number[];
}

interface IndexState {
  key: string;
  id: string;
  path: string;
  encoding: Encoding;
  marks: number[];
  scannedTo: number;
  newlines: number;
  tailNewline: boolean;
  lastPersistedTo: number;
  building: Promise<void> | null;
  error: string | null;
  fromCache: boolean;
  /** Меняется при усечении: сборка старого поколения не должна писать кэш. */
  generation: number;
}

function cacheKey(id: string, encoding: Encoding): string {
  return createHash('sha1').update(`${id}|${encoding}|${LINE_INDEX_STEP}`).digest('hex');
}

/** Сколько строк известно. У частично прочитанного файла последняя строка ещё «в работе». */
function knownLineCount(state: IndexState, size: number): number {
  if (state.scannedTo === 0 || size === 0) return 0;
  if (state.scannedTo < size) return state.newlines + 1;
  return state.newlines + (state.tailNewline ? 0 : 1);
}

/** Счётчик переводов строк в [from, to). Читает окнами, не поднимая в память больше 1 МБ. */
async function countNewlines(
  path: string,
  encoding: Encoding,
  from: number,
  to: number,
): Promise<number> {
  if (to <= from) return 0;
  const handle = await open(path, 'r');
  try {
    return await readAndCount(handle, encoding, from, to);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readAndCount(
  handle: FileHandle,
  encoding: Encoding,
  from: number,
  to: number,
): Promise<number> {
  let position = from;
  let count = 0;
  while (position < to) {
    const length = Math.min(LINE_INDEX_CHUNK_BYTES, to - position);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) break;
    count += collectLineEnds(buffer.subarray(0, bytesRead), encoding).length;
    position += bytesRead;
  }
  return count;
}

/** Смещение начала строки, отстоящей от from на skipLines переводов строк. */
async function findLineStart(
  path: string,
  encoding: Encoding,
  from: number,
  skipLines: number,
  limit: number,
): Promise<number | null> {
  if (skipLines === 0) return from;
  const handle = await open(path, 'r');
  try {
    let position = from;
    let seen = 0;
    while (position < limit) {
      const length = Math.min(LINE_INDEX_CHUNK_BYTES, limit - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      for (const end of collectLineEnds(chunk, encoding)) {
        seen += 1;
        if (seen === skipLines) return position + end;
      }
      position += bytesRead;
    }
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Разреженный индекс строк. Засечка каждые 1024 строки, поэтому номер любой строки
 * ищется чтением не больше одного блока от ближайшей засечки, а не проходом от начала.
 * Кэш именуется по `dev:ino + encoding`: переименование при ротации индекс не теряет,
 * новый файл и смена кодировки — теряют.
 */
export class LineIndexService {
  private readonly states = new Map<string, IndexState>();
  private readonly loading = new Map<string, Promise<IndexState>>();

  constructor(private readonly cacheDir: string = CACHE_DIR) {}

  /** Статус без запуска сборки. */
  async status(input: LineIndexInput): Promise<LineIndexStatus> {
    const state = await this.ensureState(input);
    this.normalize(state, input.size);
    return this.statusOf(state, input.size);
  }

  /** Запускает достройку в фоне и сразу возвращает прогресс. */
  async start(input: LineIndexInput): Promise<LineIndexStatus> {
    const state = await this.ensureState(input);
    this.normalize(state, input.size);
    state.error = null;
    if (!state.building && state.scannedTo < input.size) {
      state.building = this.build(state, input.path, input.size);
    }
    return this.statusOf(state, input.size);
  }

  /** Номер строки для байтового смещения её начала или null, если индекс не покрывает. */
  async lineNumberAt(input: LineIndexInput, offset: number): Promise<number | null> {
    if (!Number.isFinite(offset) || offset < 0) return null;
    const state = await this.ensureState(input);
    // Чистый запрос не сбрасывает индекс: размер из пула может быть на несколько секунд
    // старее, чем у сборки, и это не усечение. Сброс делает status/start по свежему stat.
    if (state.scannedTo === 0) return null;
    if (offset > state.scannedTo) return null;
    // Позиция ровно на конце просканированного куска — начало строки только если
    // кусок закончился переводом строки и за ним есть байты.
    if (offset === state.scannedTo && (!state.tailNewline || offset >= input.size)) return null;

    const mark = findMark(state.marks, offset);
    if (mark < 0) return null;
    const base = 1 + mark * LINE_INDEX_STEP;
    const from = state.marks[mark] as number;
    if (offset === from) return base;
    const newlines = await countNewlines(input.path, state.encoding, from, offset);
    return base + newlines;
  }

  /** Смещение начала строки N или null, если такой строки индекс ещё не знает. */
  async offsetForLine(input: LineIndexInput, line: number): Promise<number | null> {
    if (!Number.isInteger(line) || line < 1) return null;
    const state = await this.ensureState(input);
    if (line > knownLineCount(state, input.size)) return null;

    const mark = Math.floor((line - 1) / LINE_INDEX_STEP);
    const from = state.marks[mark];
    if (from === undefined) return null;
    const skip = line - (1 + mark * LINE_INDEX_STEP);
    return findLineStart(input.path, state.encoding, from, skip, state.scannedTo);
  }

  private statusOf(state: IndexState, size: number): LineIndexStatus {
    const complete = state.scannedTo >= size;
    return {
      state: state.error ? 'error' : state.building ? 'building' : complete ? 'ready' : 'idle',
      knownLines: knownLineCount(state, size),
      scannedTo: state.scannedTo,
      size,
      step: LINE_INDEX_STEP,
      complete,
      encoding: state.encoding,
      fromCache: state.fromCache,
      error: state.error,
    };
  }

  private async ensureState(input: LineIndexInput): Promise<IndexState> {
    const key = cacheKey(input.id, input.encoding);
    const existing = this.states.get(key);
    if (existing) return existing;

    const pending = this.loading.get(key);
    if (pending) return pending;

    const promise = this.loadState(key, input);
    this.loading.set(key, promise);
    try {
      const state = await promise;
      this.states.set(key, state);
      return state;
    } finally {
      this.loading.delete(key);
    }
  }

  private async loadState(key: string, input: LineIndexInput): Promise<IndexState> {
    const state: IndexState = {
      key,
      id: input.id,
      path: input.path,
      encoding: input.encoding,
      marks: [],
      scannedTo: 0,
      newlines: 0,
      tailNewline: false,
      lastPersistedTo: 0,
      building: null,
      error: null,
      fromCache: false,
      generation: 0,
    };

    try {
      const raw = await readFile(this.cachePath(key), 'utf8');
      const cache = JSON.parse(raw) as CacheFile;
      const expectedMarks =
        cache.scannedTo > 0 ? 1 + Math.floor(cache.newlines / LINE_INDEX_STEP) : 0;
      const valid =
        cache.version === 1 &&
        cache.step === LINE_INDEX_STEP &&
        cache.id === input.id &&
        cache.encoding === input.encoding &&
        Number.isInteger(cache.scannedTo) &&
        cache.scannedTo >= 0 &&
        cache.scannedTo <= input.size &&
        Number.isInteger(cache.newlines) &&
        cache.newlines >= 0 &&
        Array.isArray(cache.marks) &&
        cache.marks.length === expectedMarks &&
        cache.marks.every((value) => Number.isInteger(value) && value >= 0) &&
        (cache.marks.length === 0 || cache.marks[0] === 0);
      if (valid) {
        state.marks = cache.marks;
        state.scannedTo = cache.scannedTo;
        state.newlines = cache.newlines;
        state.tailNewline = Boolean(cache.tailNewline);
        state.lastPersistedTo = cache.scannedTo;
        state.fromCache = cache.scannedTo > 0;
      }
    } catch {
      // Кэша нет или он битый — начинаем с нуля. Индекс вспомогательный, ошибка чтения
      // кэша не должна ломать открытие лога.
    }
    return state;
  }

  /**
   * Файл усечён — индекс относится к другому содержимому. Сборку старого поколения
   * не ждём: она увидит смену generation и не запишет кэш.
   */
  private normalize(state: IndexState, size: number): void {
    if (size >= state.scannedTo) return;
    state.marks = [];
    state.scannedTo = 0;
    state.newlines = 0;
    state.tailNewline = false;
    state.lastPersistedTo = 0;
    state.fromCache = false;
    state.error = null;
    state.generation += 1;
  }

  private async build(state: IndexState, path: string, targetSize: number): Promise<void> {
    const generation = state.generation;
    let handle: FileHandle | null = null;
    try {
      handle = await open(path, 'r');
      while (state.scannedTo < targetSize && state.generation === generation) {
        const base = state.scannedTo;
        const length = Math.min(LINE_INDEX_CHUNK_BYTES, targetSize - base);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, base);
        if (bytesRead === 0) break;
        this.consume(state, buffer.subarray(0, bytesRead), base);
        if (state.scannedTo - state.lastPersistedTo >= LINE_INDEX_SAVE_BYTES) {
          await this.persist(state);
        }
      }
      // Частичный индекс тоже ценен, но кэшировать чужое поколение нельзя.
      if (state.generation === generation) await this.persist(state);
    } catch (error) {
      state.error = (error as Error).message;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      state.building = null;
    }
  }

  private consume(state: IndexState, chunk: Buffer, base: number): void {
    if (state.scannedTo === 0 && chunk.length > 0) state.marks.push(0);
    const ends = collectLineEnds(chunk, state.encoding);
    for (const end of ends) {
      state.newlines += 1;
      if (state.newlines % LINE_INDEX_STEP === 0) state.marks.push(base + end);
    }
    if (chunk.length > 0) {
      state.tailNewline = ends.length > 0 && ends[ends.length - 1] === chunk.length;
    }
    state.scannedTo = base + chunk.length;
  }

  private async persist(state: IndexState): Promise<void> {
    if (state.scannedTo === 0) return;
    const payload: CacheFile = {
      version: 1,
      id: state.id,
      encoding: state.encoding,
      step: LINE_INDEX_STEP,
      path: state.path,
      scannedTo: state.scannedTo,
      newlines: state.newlines,
      tailNewline: state.tailNewline,
      marks: state.marks,
    };
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const target = this.cachePath(state.key);
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(payload), 'utf8');
      await rename(tmp, target);
      state.lastPersistedTo = state.scannedTo;
    } catch {
      // Кэш — оптимизация; сбой записи не должен останавливать просмотр.
    }
  }

  private cachePath(key: string): string {
    return join(this.cacheDir, `lines-${key}.json`);
  }
}

/** Индекс последней засечки не позже offset. */
function findMark(marks: number[], offset: number): number {
  let low = 0;
  let high = marks.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((marks[middle] as number) <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}
