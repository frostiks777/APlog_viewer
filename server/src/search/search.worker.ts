import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import type { Encoding } from '../files/encoding.js';
import { collectLineEnds, decodeLineSlice } from '../files/lines.js';
import type { SearchMatch, SearchRequest, SearchWorkerReply } from './protocol.js';

const READ_WINDOW = 256 * 1024;
const ALIGN_WINDOW = 64 * 1024;
const ALIGN_LIMIT = 4 * 1024 * 1024;
/** Длинную строку в панель не влезет: в ответе храним только начало. */
const MAX_MATCH_TEXT = 2000;

const request = workerData as SearchRequest;

function post(reply: SearchWorkerReply): void {
  parentPort?.postMessage(reply);
}

/**
 * Начало строки, в которой лежит offset (или сам offset, если он уже начало).
 * Окно читается назад, пока не найдётся перевод: окно поиска должно начинаться
 * с границы строки, иначе первая строка будет обрезана и даст ложное совпадение.
 */
function lineStartAtOrBefore(fd: number, offset: number, encoding: Encoding): number {
  if (offset <= 0) return 0;
  let end = offset;
  let budget = ALIGN_LIMIT;

  while (end > 0 && budget > 0) {
    const start = Math.max(0, end - ALIGN_WINDOW);
    const length = end - start;
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, start);
    if (read <= 0) return 0;

    const ends = collectLineEnds(buffer.subarray(0, read), encoding);
    const last = ends[ends.length - 1];
    if (last !== undefined) {
      const candidate = start + last;
      return candidate <= offset ? candidate : offset;
    }

    end = start;
    budget -= length;
  }

  // Строка длиннее 4 МБ: считаем offset границей. Такие логи не встречаются,
  // а читать дальше назад дороже, чем польза от точного выравнивания.
  return offset;
}

function createMatcher(): (text: string) => boolean {
  if (request.isRegex) {
    // Без флага g: lastIndex сделал бы результат зависимым от порядка строк.
    const expression = new RegExp(request.query, request.caseSensitive ? '' : 'i');
    return (text) => expression.test(text);
  }

  const needle = request.caseSensitive ? request.query : request.query.toLowerCase();
  return request.caseSensitive
    ? (text) => text.includes(needle)
    : (text) => text.toLowerCase().includes(needle);
}

interface ScanResult {
  matches: SearchMatch[];
  cursor: number;
  scannedBytes: number;
}

/**
 * Последовательный скан [from, until). Обе границы — начала строк, поэтому
 * последняя строка перед until тоже целая. Курсор всегда указывает на начало
 * строки: после последнего совпадения или на первую непросмотренную.
 */
function scanRange(
  fd: number,
  from: number,
  until: number,
  encoding: Encoding,
  test: (text: string) => boolean,
  maxBytes: number,
  /** Сколько совпадений уже достаточно, чтобы прекратить скан (вперёд). */
  stopLimit: number,
  /** Сколько последних совпадений хранить; Infinity — все (вперёд). */
  retain: number,
): ScanResult {
  const matches: SearchMatch[] = [];
  let position = from;
  let buffer = Buffer.alloc(0);
  let bufferStart = from;
  let scanned = 0;
  let cursor = from;
  let reported = 0;

  const take = (start: number, end: number) => {
    const text = decodeLineSlice(buffer, start, end, bufferStart, encoding);
    if (!test(text)) return;
    matches.push({
      offset: bufferStart + start,
      endOffset: bufferStart + end,
      text: text.length > MAX_MATCH_TEXT ? `${text.slice(0, MAX_MATCH_TEXT)}…` : text,
    });
    // Назад нужны ближайшие к курсору совпадения, но скан идёт от дальнего края
    // окна. Держим кольцо, иначе окно в 16 МБ с частыми совпадениями съест память.
    if (Number.isFinite(retain) && matches.length > retain * 2) {
      matches.splice(0, matches.length - retain);
    }
  };

  while (position < until && scanned < maxBytes && matches.length < stopLimit) {
    const length = Math.min(READ_WINDOW, until - position, maxBytes - scanned);
    if (length <= 0) break;

    const chunk = Buffer.allocUnsafe(length);
    const read = readSync(fd, chunk, 0, length, position);
    if (read <= 0) break;
    position += read;
    scanned += read;
    buffer =
      buffer.length === 0 ? chunk.subarray(0, read) : Buffer.concat([buffer, chunk.subarray(0, read)]);

    const ends = collectLineEnds(buffer, encoding);
    let lineStart = 0;
    for (const end of ends) {
      take(lineStart, end);
      lineStart = end;
      if (matches.length >= stopLimit) break;
    }
    if (matches.length >= stopLimit) break;

    if (position >= until) {
      // until — начало строки, поэтому остаток [lineStart, buffer.length) целый.
      if (lineStart < buffer.length) take(lineStart, buffer.length);
      cursor = bufferStart + buffer.length;
      break;
    }

    if (lineStart === 0 && scanned >= maxBytes && position < until) {
      // Одна строка длиннее лимита. Иначе курсор остался бы на месте и следующий
      // запрос читал бы тот же участок бесконечно. lineStartAtOrBefore тоже
      // ограничен 4 МБ, поэтому примет этот offset за границу.
      cursor = bufferStart + buffer.length;
      break;
    }

    buffer = buffer.subarray(lineStart);
    bufferStart += lineStart;
    cursor = bufferStart;

    if (matches.length !== reported) {
      reported = matches.length;
      post({ type: 'progress', matches: [...matches] });
    }
  }

  if (stopLimit !== Number.POSITIVE_INFINITY && matches.length >= stopLimit) {
    cursor = (matches[matches.length - 1] as SearchMatch).endOffset;
  }
  return { matches, cursor, scannedBytes: scanned };
}

function run(): void {
  let fd: number | null = null;
  try {
    fd = openSync(request.path, 'r');
    const stats = fstatSync(fd);
    // Размер зафиксирован на момент запроса: дописанные во время скана байты
    // не должны менять границу и курсор.
    const size = Math.min(request.size > 0 ? request.size : stats.size, stats.size);
    const test = createMatcher();

    if (request.direction === 'backward') {
      const end = Math.min(Math.max(0, Math.floor(request.fromOffset)), size);
      if (end === 0) {
        post({ type: 'done', matches: [], cursor: 0, eof: true, scannedBytes: 0, size });
        return;
      }

      const windowStart = lineStartAtOrBefore(
        fd,
        Math.max(0, end - request.maxBytes),
        request.encoding,
      );
      // Окно уже ограничено maxBytes; сканируем его целиком, иначе потеряем
      // совпадения у правой границы — те, что ближе к курсору.
      const scan = scanRange(
        fd,
        windowStart,
        end,
        request.encoding,
        test,
        end - windowStart,
        Number.POSITIVE_INFINITY,
        request.limit,
      );
      const tail = scan.matches.slice(-request.limit);
      post({
        type: 'done',
        matches: tail,
        cursor: tail[0]?.offset ?? windowStart,
        // Если лимит обрезал окно, более ранние совпадения ещё не просмотрены.
        eof: windowStart === 0 && tail.length < request.limit,
        scannedBytes: end - windowStart,
        size,
      });
      return;
    }

    const start = lineStartAtOrBefore(
      fd,
      Math.min(Math.max(0, Math.floor(request.fromOffset)), size),
      request.encoding,
    );
    const scan = scanRange(
      fd,
      start,
      size,
      request.encoding,
      test,
      request.maxBytes,
      request.limit,
      Number.POSITIVE_INFINITY,
    );
    post({
      type: 'done',
      matches: scan.matches,
      cursor: scan.cursor,
      eof: scan.cursor >= size,
      scannedBytes: scan.scannedBytes,
      size,
    });
  } catch (error) {
    post({ type: 'error', message: (error as Error).message });
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* файл уже мог быть закрыт системой при ошибке */
      }
    }
  }
}

run();
