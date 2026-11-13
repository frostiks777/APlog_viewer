import { Worker } from 'node:worker_threads';
import { SEARCH_TIMEOUT_MS } from '../config.js';
import type { SearchMatch, SearchOutcome, SearchRequest, SearchWorkerReply } from './protocol.js';

/** В dev воркер — .ts, и его нужно запускать через tsx; в dist уже готовый .js. */
function workerUrl(): { url: URL; execArgv: string[] } {
  const isTypeScript = import.meta.url.endsWith('.ts');
  return {
    url: new URL(isTypeScript ? './search.worker.ts' : './search.worker.js', import.meta.url),
    execArgv: isTypeScript ? ['--import', 'tsx'] : [],
  };
}

/**
 * Частичный результат при таймауте. Вперёд прогресс безопасен: он идёт от курсора
 * и найденные строки уже не изменятся. Назад прогресс начинается с дальнего края
 * окна, поэтому отдавать его нельзя — пользователь прыгнул бы через совпадения.
 */
function partial(request: SearchRequest, progress: SearchMatch[], timedOut: boolean): SearchOutcome {
  const matches = request.direction === 'forward' ? progress : [];
  const cursor =
    matches.length === 0
      ? request.fromOffset
      : request.direction === 'forward'
        ? (matches[matches.length - 1] as SearchMatch).endOffset
        : (matches[0] as SearchMatch).offset;
  return {
    matches,
    cursor,
    eof: false,
    scannedBytes: 0,
    size: request.size,
    timedOut,
  };
}

export function runSearch(request: SearchRequest): Promise<SearchOutcome> {
  return new Promise((resolve) => {
    const { url, execArgv } = workerUrl();
    const worker = new Worker(url, { workerData: request, execArgv });

    let progress: SearchMatch[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (outcome: SearchOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };

    timer = setTimeout(() => finish(partial(request, progress, true)), SEARCH_TIMEOUT_MS);

    worker.on('message', (reply: SearchWorkerReply) => {
      if (reply.type === 'progress') {
        progress = reply.matches;
        return;
      }
      if (reply.type === 'error') {
        finish({ ...partial(request, progress, false), error: reply.message });
        return;
      }
      finish({ ...reply, timedOut: false });
    });

    worker.on('error', (error: Error) => {
      finish({ ...partial(request, progress, false), error: error.message });
    });

    worker.on('exit', (code) => {
      if (!settled) {
        finish({
          ...partial(request, progress, false),
          error: `Процесс поиска завершился с кодом ${code}`,
        });
      }
    });
  });
}
