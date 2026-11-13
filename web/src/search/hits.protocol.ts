/** Сообщения воркера подсветки всех совпадений в загруженном буфере. */

export interface HitsRequest {
  type: 'hits';
  id: number;
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  lines: string[];
}

export type HitsReply =
  | { type: 'start'; id: number }
  | { type: 'done'; id: number; hits: number[] };
