/** Сообщения между главным потоком и воркером матчинга. */

export interface WorkerRule {
  id: string;
  match: string;
  isRegex: boolean;
  caseSensitive: boolean;
}

export interface EvalRequest {
  type: 'eval';
  id: number;
  /** Правила подсветки по убыванию приоритета. */
  rules: WorkerRule[];
  include: WorkerRule[];
  exclude: WorkerRule[];
  /** Все строки буфера: подсветка и видимость считаются в одном проходе. */
  lines: string[];
}

export interface RuleError {
  id: string;
  message: string;
}

export type WorkerReply =
  | { type: 'start'; id: number; ruleId: string }
  | {
      type: 'done';
      id: number;
      styles: Array<string | null>;
      visible: Uint8Array;
      errors: RuleError[];
    }
  | { type: 'fatal'; id: number; message: string };
