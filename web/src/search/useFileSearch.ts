import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SearchDirection, type SearchMatch } from '../api';

/** Сколько совпадений просим за один запрос — больше в панель всё равно не влезет. */
const SEARCH_LIMIT = 200;
/** Сколько окон подряд сканируем по одному нажатию, прежде чем показать «дальше нет». */
const MAX_ATTEMPTS = 2;

interface SearchSession {
  /** Запрос и флаги, к которым относятся совпадения. */
  key: string;
  matches: SearchMatch[];
  index: number;
  forwardCursor: number;
  backwardCursor: number;
  eofForward: boolean;
  eofBackward: boolean;
}

export interface FileSearch {
  query: string;
  setQuery: (value: string) => void;
  isRegex: boolean;
  caseSensitive: boolean;
  match: SearchMatch | null;
  index: number;
  total: number;
  /** Поиск уже запускался для текущего запроса. */
  tried: boolean;
  /** Все совпадения в обе стороны уже найдены. */
  complete: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  next: () => void;
  prev: () => void;
  clear: () => void;
}

interface SearchOptions {
  tabId: string | null;
  /** С какого места начинать новый поиск: первая видимая строка. */
  anchorOffset: number;
  isRegex: boolean;
  caseSensitive: boolean;
  onReveal: (offset: number) => void | Promise<void>;
}

function sessionKey(
  tabId: string | null,
  query: string,
  isRegex: boolean,
  caseSensitive: boolean,
): string {
  return `${tabId ?? '-'}|${isRegex ? 'r' : 's'}${caseSensitive ? 'c' : 'i'}:${query}`;
}

export function useFileSearch(options: SearchOptions): FileSearch {
  const [query, setQuery] = useState('');
  const [session, setSessionState] = useState<SearchSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const sessionRef = useRef<SearchSession | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const busyRef = useRef(false);
  const setSession = useCallback((next: SearchSession | null) => {
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  // Смена вкладки обнуляет сессию: смещения принадлежат другому файлу.
  useEffect(() => {
    setSession(null);
    setError(null);
    setNotice(null);
    busyRef.current = false;
    setBusy(false);
  }, [options.tabId, setSession]);

  const run = useCallback(
    async (direction: SearchDirection) => {
      if (busyRef.current) return;

      const current = optionsRef.current;
      const tab = current.tabId;
      const text = queryRef.current;
      if (!tab) return;
      if (!text) {
        setError('Введите строку поиска');
        return;
      }

      // Любая навигация снимает прошлое сообщение: иначе «ниже совпадений нет»
      // висело бы над списком после успешного Shift+F3.
      setError(null);
      setNotice(null);

      const key = sessionKey(tab, text, current.isRegex, current.caseSensitive);
      let state = sessionRef.current;
      if (!state || state.key !== key) {
        state = {
          key,
          matches: [],
          index: -1,
          forwardCursor: current.anchorOffset,
          backwardCursor: current.anchorOffset,
          eofForward: false,
          eofBackward: false,
        };
      }

      // Шаг по уже найденным — без запроса к серверу.
      if (direction === 'forward' && state.index + 1 < state.matches.length) {
        const next = { ...state, index: state.index + 1 };
        setSession(next);
        await current.onReveal((next.matches[next.index] as SearchMatch).offset);
        return;
      }
      if (direction === 'backward' && state.index > 0) {
        const next = { ...state, index: state.index - 1 };
        setSession(next);
        await current.onReveal((next.matches[next.index] as SearchMatch).offset);
        return;
      }
      if (direction === 'backward' && state.index < 0 && state.matches.length > 0) {
        const next = { ...state, index: state.matches.length - 1 };
        setSession(next);
        await current.onReveal((next.matches[next.index] as SearchMatch).offset);
        return;
      }

      if (direction === 'forward' ? state.eofForward : state.eofBackward) {
        setNotice(direction === 'forward' ? 'Ниже совпадений нет' : 'Выше совпадений нет');
        return;
      }

      busyRef.current = true;
      setBusy(true);

      let cursor = direction === 'forward' ? state.forwardCursor : state.backwardCursor;
      const known = new Set(state.matches.map((item) => item.offset));
      const added: SearchMatch[] = [];
      let eof = false;
      let timedOut = false;
      let event: 'ok' | 'rotated' | 'truncated' = 'ok';

      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          const result = await api.search(tab, {
            query: text,
            isRegex: current.isRegex,
            caseSensitive: current.caseSensitive,
            direction,
            fromOffset: cursor,
            limit: SEARCH_LIMIT,
          });

          // Пока шёл запрос, пользователь мог сменить вкладку или запрос.
          const fresh = optionsRef.current;
          if (
            fresh.tabId !== tab ||
            fresh.isRegex !== current.isRegex ||
            fresh.caseSensitive !== current.caseSensitive ||
            queryRef.current !== text
          ) {
            return;
          }

          for (const match of result.matches) {
            if (known.has(match.offset)) continue;
            known.add(match.offset);
            added.push(match);
          }
          cursor = result.cursor;
          eof = result.eof;
          timedOut = result.timedOut;
          event = result.event;

          if (timedOut || added.length > 0 || eof) break;
        }

        const merged = new Map(state.matches.map((item) => [item.offset, item]));
        for (const match of added) merged.set(match.offset, match);
        const matches = [...merged.values()].sort((left, right) => left.offset - right.offset);

        const next: SearchSession = {
          ...state,
          matches,
          forwardCursor: direction === 'forward' ? cursor : state.forwardCursor,
          backwardCursor: direction === 'backward' ? cursor : state.backwardCursor,
          eofForward: direction === 'forward' ? eof : state.eofForward,
          eofBackward: direction === 'backward' ? eof : state.eofBackward,
        };

        if (added.length > 0) {
          const target =
            direction === 'forward'
              ? Math.min(...added.map((item) => item.offset))
              : Math.max(...added.map((item) => item.offset));
          next.index = matches.findIndex((item) => item.offset === target);
        }

        if (timedOut) {
          setError('Поиск прерван: выражение не уложилось в 5 секунд');
        } else if (event !== 'ok') {
          setNotice('Файл изменился — результаты относятся к новому состоянию');
        } else if (added.length === 0) {
          setNotice(
            eof
              ? direction === 'forward'
                ? 'Ниже совпадений нет'
                : 'Выше совпадений нет'
              : 'В просмотренном диапазоне нет — нажмите ещё',
          );
        }

        setSession(next);
        if (next.index >= 0) {
          await current.onReveal((next.matches[next.index] as SearchMatch).offset);
        }
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [setSession],
  );

  const next = useCallback(() => {
    void run('forward');
  }, [run]);
  const prev = useCallback(() => {
    void run('backward');
  }, [run]);
  const clear = useCallback(() => {
    setQuery('');
    setSession(null);
    setError(null);
    setNotice(null);
  }, [setSession]);

  const key = sessionKey(options.tabId, query, options.isRegex, options.caseSensitive);
  const active = session && session.key === key ? session : null;
  const match = active && active.index >= 0 ? (active.matches[active.index] ?? null) : null;

  return {
    query,
    setQuery,
    isRegex: options.isRegex,
    caseSensitive: options.caseSensitive,
    match,
    index: active?.index ?? -1,
    total: active?.matches.length ?? 0,
    tried: Boolean(active),
    complete: Boolean(active?.eofForward && active?.eofBackward),
    busy,
    error,
    notice,
    next,
    prev,
    clear,
  };
}
