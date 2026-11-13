import { compileMatcher } from '../rules/evaluate';
import type { HitsReply, HitsRequest } from './hits.protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<HitsRequest>) => void) | null;
  postMessage(message: HitsReply): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const request = event.data;
  if (!request || request.type !== 'hits') return;

  // Главный поток взводит вотчдог по этому сообщению: до него воркер мог только
  // импортироваться, а зависнуть может лишь матчинг.
  scope.postMessage({ type: 'start', id: request.id });

  const { matcher } = compileMatcher({
    id: 'search-hits',
    match: request.query,
    isRegex: request.isRegex,
    caseSensitive: request.caseSensitive,
  });

  const hits: number[] = [];
  if (matcher) {
    for (let index = 0; index < request.lines.length; index += 1) {
      const line = request.lines[index];
      if (line !== undefined && matcher.test(line)) hits.push(index);
    }
  }

  scope.postMessage({ type: 'done', id: request.id, hits });
};
