import type { Encoding } from '../files/encoding.js';

export type SearchDirection = 'forward' | 'backward';

export interface SearchMatch {
  /** Байтовое смещение начала строки — стабильный адрес для перехода. */
  offset: number;
  /** Смещение сразу после строки, включая перевод; с него продолжается поиск вперёд. */
  endOffset: number;
  text: string;
}

export interface SearchRequest {
  path: string;
  encoding: Encoding;
  /** Размер на момент запроса: поиск не должен уходить в дописанные во время скана байты. */
  size: number;
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  direction: SearchDirection;
  fromOffset: number;
  limit: number;
  maxBytes: number;
}

export type SearchWorkerReply =
  | { type: 'progress'; matches: SearchMatch[] }
  | {
      type: 'done';
      matches: SearchMatch[];
      /** Начало строки, с которого продолжается поиск в том же направлении. */
      cursor: number;
      eof: boolean;
      scannedBytes: number;
      size: number;
    }
  | { type: 'error'; message: string };

export interface SearchOutcome {
  matches: SearchMatch[];
  cursor: number;
  eof: boolean;
  scannedBytes: number;
  size: number;
  timedOut: boolean;
  error?: string;
}
