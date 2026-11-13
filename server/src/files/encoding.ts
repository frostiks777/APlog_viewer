import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import iconv from 'iconv-lite';

export const ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'cp1251', 'cp866', 'latin1'] as const;
export type Encoding = (typeof ENCODINGS)[number];

const ICONV_NAMES: Record<Encoding, string> = {
  'utf-8': 'utf8',
  'utf-16le': 'utf16-le',
  'utf-16be': 'utf16-be',
  cp1251: 'win1251',
  cp866: 'cp866',
  latin1: 'latin1',
};

export function isEncoding(value: unknown): value is Encoding {
  return typeof value === 'string' && (ENCODINGS as readonly string[]).includes(value);
}

export function decode(buffer: Buffer, encoding: Encoding): string {
  if (encoding === 'utf-8') return buffer.toString('utf8');
  return iconv.decode(buffer, ICONV_NAMES[encoding]);
}

export function encode(text: string, encoding: Encoding): Buffer {
  if (encoding === 'utf-8') return Buffer.from(text, 'utf8');
  return iconv.encode(text, ICONV_NAMES[encoding]);
}

/** Индекс последнего перевода строки в буфере или -1. */
function lastNewlineOffset(buffer: Buffer): number {
  for (let i = buffer.length - 1; i >= 0; i -= 1) {
    if (buffer[i] === 0x0a) return i;
  }
  return -1;
}

/**
 * Определяет кодировку по первым килобайтам файла.
 * Порядок: BOM -> доля NUL (UTF-16 без BOM) -> строгая проверка UTF-8 -> cp1251.
 */
export async function detectEncoding(path: string): Promise<Encoding> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return 'utf-8';
    const head = buffer.subarray(0, bytesRead);

    if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf-8';
    if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
    if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';

    let zeros = 0;
    for (const byte of head) if (byte === 0) zeros += 1;
    if (zeros / head.length > 0.25) return head[0] === 0x00 ? 'utf-16be' : 'utf-16le';

    // Обрезаем хвост по последнему переводу строки: иначе разрезанная многобайтовая
    // последовательность даст ложный отрицательный результат.
    const cut = lastNewlineOffset(head);
    const sample = cut > 0 ? head.subarray(0, cut) : head;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample);
      return 'utf-8';
    } catch {
      return 'cp1251';
    }
  } finally {
    await handle.close();
  }
}

/** Подсказка по расширению — используется только когда файл пуст. */
export function encodingByExtension(path: string): Encoding | null {
  const ext = extname(path).toLowerCase();
  if (ext === '.log' || ext === '.txt' || ext === '.json') return 'utf-8';
  return null;
}
