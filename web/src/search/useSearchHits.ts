import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogLine } from '../api';
import type { HitsReply } from './hits.protocol';

const DEBOUNCE_MS = 150;
/** Тот же бюджет, что у правил: подсветка не должна подвешивать ввод. */
const HITS_BUDGET_MS = 400;

export interface SearchHits {
  /** Смещения строк буфера, совпавших с запросом; null — подсветки нет. */
  hits: Set<number> | null;
  /** Воркер не уложился в бюджет; подсветка выключена до смены запроса. */
  timedOut: boolean;
}

interface HitsInput {
  tabId: string | null;
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  lines: LogLine[];
}

interface Pending {
  id: number;
  key: string;
  lines: LogLine[];
}

function keyOf(input: HitsInput): string {
  return `${input.tabId ?? '-'}|${input.isRegex ? 'r' : 's'}${input.caseSensitive ? 'c' : 'i'}:${input.query}`;
}

export function useSearchHits(input: HitsInput): SearchHits {
  const [hits, setHits] = useState<Set<number> | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const inputRef = useRef(input);
  inputRef.current = input;

  const key = keyOf(input);
  const keyRef = useRef(key);
  keyRef.current = key;

  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const sequenceRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const blockedKeyRef = useRef<string | null>(null);
  const lastKeyRef = useRef(key);
  const sendRef = useRef<() => void>(() => undefined);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopWorker = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    pendingRef.current = null;
  }, []);

  const failRef = useRef<(failedKey: string) => void>(() => undefined);
  const fail = useCallback(
    (failedKey: string) => {
      stopWorker();
      clearTimer();
      blockedKeyRef.current = failedKey;
      setHits(null);
      setTimedOut(true);
    },
    [clearTimer, stopWorker],
  );
  failRef.current = fail;

  const armWatchdog = useCallback(
    (watchedKey: string) => {
      clearTimer();
      timerRef.current = window.setTimeout(() => failRef.current(watchedKey), HITS_BUDGET_MS);
    },
    [clearTimer],
  );

  const send = useCallback(() => {
    const current = inputRef.current;
    const currentKey = keyRef.current;

    if (!current.query) {
      stopWorker();
      clearTimer();
      setHits(null);
      setTimedOut(false);
      return;
    }
    if (blockedKeyRef.current === currentKey) return;

    // Прошлый запрос уже не нужен. Если он завис, новый воркер не должен наследовать
    // это зависание, поэтому старый убиваем, а не ставим запрос в очередь.
    if (pendingRef.current) {
      stopWorker();
      clearTimer();
    }

    const id = sequenceRef.current + 1;
    sequenceRef.current = id;
    pendingRef.current = { id, key: currentKey, lines: current.lines };

    let worker = workerRef.current;
    if (!worker) {
      try {
        worker = new Worker(new URL('./hits.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        fail(currentKey);
        return;
      }
      worker.onmessage = (event: MessageEvent<HitsReply>) => {
        const reply = event.data;
        const pending = pendingRef.current;
        if (!pending || reply.id !== pending.id) return;

        if (reply.type === 'start') {
          armWatchdog(pending.key);
          return;
        }

        // Запрос устарел, пока воркер считал: его маркеры относятся к другому буферу.
        if (pending.key !== keyRef.current) return;

        clearTimer();
        pendingRef.current = null;
        const offsets = new Set<number>();
        for (const index of reply.hits) {
          const line = pending.lines[index];
          if (line) offsets.add(line.offset);
        }
        setHits(offsets);
        setTimedOut(false);
      };
      worker.onerror = () => fail(currentKey);
      workerRef.current = worker;
    }

    armWatchdog(currentKey);
    worker.postMessage({
      type: 'hits',
      id,
      query: current.query,
      isRegex: current.isRegex,
      caseSensitive: current.caseSensitive,
      lines: current.lines.map((line) => line.text),
    });
  }, [armWatchdog, clearTimer, fail, stopWorker]);

  sendRef.current = send;

  useEffect(() => {
    if (!input.query) {
      blockedKeyRef.current = null;
      lastKeyRef.current = key;
      setHits(null);
      setTimedOut(false);
      return;
    }

    // Смена запроса/вкладки снимает старые маркеры сразу, не дожидаясь debounce.
    if (lastKeyRef.current !== key) {
      lastKeyRef.current = key;
      setHits(null);
    }
    if (blockedKeyRef.current !== null && blockedKeyRef.current !== key) {
      blockedKeyRef.current = null;
      setTimedOut(false);
    }

    const timer = window.setTimeout(() => sendRef.current(), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [key, input.lines, input.query]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [],
  );

  return { hits, timedOut };
}
