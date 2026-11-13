import { decode, type Encoding } from './encoding.js';

const NEWLINE = 0x0a;
const CARRIAGE = 0x0d;

export interface DecodedLine {
  /** Байтовое смещение начала строки в файле. */
  offset: number;
  text: string;
}

function isUtf16(encoding: Encoding): boolean {
  return encoding === 'utf-16le' || encoding === 'utf-16be';
}

/**
 * Длина перевода строки, начинающегося в позиции index, или -1.
 * В UTF-16 перевод строки — двухбайтовая пара, и побайтовый поиск 0x0A её ломает:
 * остаётся нулевой байт, который попадает в текст следующей строки.
 */
export function newlineEndAt(buffer: Buffer, index: number, encoding: Encoding): number {
  if (encoding === 'utf-16le') {
    return buffer[index] === NEWLINE && buffer[index + 1] === 0x00 ? index + 2 : -1;
  }
  if (encoding === 'utf-16be') {
    return buffer[index] === 0x00 && buffer[index + 1] === NEWLINE ? index + 2 : -1;
  }
  return buffer[index] === NEWLINE ? index + 1 : -1;
}

/** Границы строк (индекс сразу после перевода) в порядке возрастания. */
export function collectLineEnds(
  buffer: Buffer,
  encoding: Encoding,
  maxCount = Number.POSITIVE_INFINITY,
): number[] {
  const ends: number[] = [];
  const last = buffer.length - (isUtf16(encoding) ? 1 : 0);
  for (let i = 0; i < last; i += 1) {
    const end = newlineEndAt(buffer, i, encoding);
    if (end > 0) {
      ends.push(end);
      if (ends.length >= maxCount) break;
    }
  }
  return ends;
}

/**
 * Конец текста строки без перевода строки. end указывает СРАЗУ ПОСЛЕ перевода,
 * поэтому LF отрезается всегда, а CR — только если он есть (CRLF).
 */
export function textEndFor(buffer: Buffer, start: number, end: number, encoding: Encoding): number {
  if (encoding === 'utf-16le') {
    const hasCr = end - start >= 4 && buffer[end - 4] === CARRIAGE && buffer[end - 3] === 0x00;
    return hasCr ? end - 4 : end - 2;
  }
  if (encoding === 'utf-16be') {
    const hasCr = end - start >= 4 && buffer[end - 4] === 0x00 && buffer[end - 3] === CARRIAGE;
    return hasCr ? end - 4 : end - 2;
  }
  return end - start >= 2 && buffer[end - 2] === CARRIAGE ? end - 2 : end - 1;
}

/**
 * BOM — часть файла, но не часть текста первой строки. Иначе в UI появляется
 * невидимый \uFEFF в начале лога.
 */
export function skipBom(buffer: Buffer, start: number, encoding: Encoding): number {
  if (start !== 0) return 0;
  if (encoding === 'utf-8' && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 3;
  if (encoding === 'utf-16le' && buffer[0] === 0xff && buffer[1] === 0xfe) return 2;
  if (encoding === 'utf-16be' && buffer[0] === 0xfe && buffer[1] === 0xff) return 2;
  return 0;
}

/**
 * Текст одной строки [start, end). end указывает сразу после перевода строки,
 * baseOffset — абсолютное смещение начала buffer: по нему определяется BOM.
 */
export function decodeLineSlice(
  buffer: Buffer,
  start: number,
  end: number,
  baseOffset: number,
  encoding: Encoding,
): string {
  // Последняя строка файла может быть без перевода: textEndFor вычитал бы её символ.
  const hasNewline =
    encoding === 'utf-16le'
      ? end - start >= 2 && buffer[end - 2] === NEWLINE && buffer[end - 1] === 0x00
      : encoding === 'utf-16be'
        ? end - start >= 2 && buffer[end - 2] === 0x00 && buffer[end - 1] === NEWLINE
        : end - start >= 1 && buffer[end - 1] === NEWLINE;
  const textEnd = hasNewline ? textEndFor(buffer, start, end, encoding) : end;
  const bom = baseOffset + start === 0 ? skipBom(buffer, start, encoding) : 0;
  return decode(buffer.subarray(start + bom, textEnd), encoding);
}

/** Разбирает буфер [0, cut) на строки; baseOffset — абсолютное смещение начала буфера. */
export function decodeLines(
  buffer: Buffer,
  cut: number,
  baseOffset: number,
  encoding: Encoding,
): DecodedLine[] {
  const ends = collectLineEnds(buffer.subarray(0, cut), encoding);
  const lines: DecodedLine[] = [];
  let start = 0;
  for (const end of ends) {
    lines.push({ offset: baseOffset + start, text: decodeLineSlice(buffer, start, end, baseOffset, encoding) });
    start = end;
  }
  if (start < cut) {
    lines.push({
      offset: baseOffset + start,
      text: decodeLineSlice(buffer, start, cut, baseOffset, encoding),
    });
  }
  return lines;
}
