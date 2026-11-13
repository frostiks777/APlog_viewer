import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FilterRule, HighlightRule, LogLine } from '../api';
import { filterAppliesToTab, ruleAppliesToTab } from './evaluate';
import type { EvalRequest, WorkerReply, WorkerRule } from './protocol';

/** Сколько ждём ответа на одно правило, прежде чем убить воркер вместе с ним. */
const WORKER_BUDGET_MS = 400;
const EVAL_DEBOUNCE_MS = 120;
const STYLE_CACHE_LIMIT = 80_000;

export interface EngineInput {
  enabled: boolean;
  rules: HighlightRule[];
  filters: FilterRule[];
  activeTabId: string | null;
  /** Весь буфер: подсветка и видимость считаются по нему одним проходом. */
  lines: LogLine[];
  /** Меняется при смене файла или кодировки: кэш стилей сбрасывается. */
  resetToken: number;
  /** Правило не уложилось в бюджет — его нужно выключить и запомнить в профиле. */
  onSlowRule: (ruleId: string) => void;
}

export interface EngineResult {
  /** ruleId подсветки по байтовому смещению строки, null — без подсветки. */
  styleOf: (offset: number) => string | null;
  /**
   * Смещения строк, скрытых фильтром. Живёт между подгрузками буфера: смещения строк
   * стабильны, поэтому фильтр не мигает на каждом append от tail.
   */
  hidden: Set<number> | null;
  busy: boolean;
}

function toWorkerRule(rule: { id: string; match: string; isRegex: boolean; caseSensitive: boolean }): WorkerRule {
  return { id: rule.id, match: rule.match, isRegex: rule.isRegex, caseSensitive: rule.caseSensitive };
}

function buildRequest(input: EngineInput, skip: Set<string>, id: number): EvalRequest {
  const ordered = input.rules
    .filter(
      (rule) =>
        rule.enabled &&
        rule.disabledReason !== 'timeout' &&
        !skip.has(rule.id) &&
        ruleAppliesToTab(rule, input.activeTabId),
    )
    .slice()
    .sort((left, right) => right.priority - left.priority);

  const filters = input.filters.filter(
    (rule) =>
      rule.enabled &&
      rule.disabledReason !== 'timeout' &&
      !skip.has(rule.id) &&
      filterAppliesToTab(rule, input.activeTabId),
  );

  return {
    type: 'eval',
    id,
    rules: ordered.map(toWorkerRule),
    include: filters.filter((rule) => rule.mode === 'include').map(toWorkerRule),
    exclude: filters.filter((rule) => rule.mode === 'exclude').map(toWorkerRule),
    lines: input.lines.map((line) => line.text),
  };
}

interface Visibility {
  hidden: Set<number>;
}

export function useRulesEngine(input: EngineInput): EngineResult {
  const [styleMap, setStyleMap] = useState<Map<number, string | null>>(() => new Map());
  const [visibility, setVisibility] = useState<Visibility | null>(null);
  const [busy, setBusy] = useState(false);  const inputRef = useRef(input);
  inputRef.current = input;

  const onSlowRef = useRef(input.onSlowRule);
  onSlowRef.current = input.onSlowRule;

  const workerRef = useRef<Worker | null>(null);
  const sequenceRef = useRef(0);
  const pendingRef = useRef<{ request: EvalRequest; lines: LogLine[] } | null>(null);
  const lastRuleRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const skipRef = useRef<Set<string>>(new Set());
  const sendRef = useRef<() => void>(() => undefined);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const armWatchdog = useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const culprit = lastRuleRef.current;
      workerRef.current?.terminate();
      workerRef.current = null;
      pendingRef.current = null;

      if (!culprit) {
        setBusy(false);
        return;
      }
      // Правило уже пробовали и снова получили таймаут — второй раз не запускаем,
      // иначе вотчдог будет перезапускать воркер бесконечно.
      if (skipRef.current.has(culprit)) {
        setBusy(false);
        return;
      }

      // Правило-виновник больше не отправляем: иначе следующие запросы зависнут так же.
      // Владелец сохранит disabledReason в профиль, чтобы и после перезагрузки было тихо.
      skipRef.current.add(culprit);
      onSlowRef.current(culprit);
      sendRef.current();
    }, WORKER_BUDGET_MS);
  }, [clearTimer]);

  const send = useCallback(() => {
    const current = inputRef.current;
    if (!current.enabled) {
      setBusy(false);
      return;
    }

    const request = buildRequest(current, skipRef.current, sequenceRef.current + 1);
    sequenceRef.current = request.id;
    pendingRef.current = { request, lines: current.lines };
    lastRuleRef.current = null;

    let worker = workerRef.current;
    if (!worker) {
      try {
        worker = new Worker(new URL('./matcher.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        setBusy(false);
        return;
      }
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        const reply = event.data;
        const pending = pendingRef.current;
        if (!pending || reply.id !== pending.request.id) return;

        if (reply.type === 'start') {
          lastRuleRef.current = reply.ruleId;
          armWatchdog();
          return;
        }
        if (reply.type === 'fatal') {
          clearTimer();
          pendingRef.current = null;
          setBusy(false);
          return;
        }

        clearTimer();
        pendingRef.current = null;

        const { lines } = pending;
        setStyleMap((previous) => {
          const next = new Map(previous);
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (!line) continue;
            next.set(line.offset, reply.styles[index] ?? null);
          }
          if (next.size <= STYLE_CACHE_LIMIT) return next;
          // Map помнит порядок вставки: оставляем хвост, старые строки уже не на экране.
          const trimmed = new Map<number, string | null>();
          let excess = next.size - STYLE_CACHE_LIMIT;
          for (const [offset, ruleId] of next) {
            if (excess > 0) {
              excess -= 1;
              continue;
            }
            trimmed.set(offset, ruleId);
          }
          return trimmed;
        });

        const filtersActive = pending.request.include.length > 0 || pending.request.exclude.length > 0;
        if (!filtersActive) {
          setVisibility(null);
        } else {
          const hidden = new Set<number>();
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (line && reply.visible[index] === 0) hidden.add(line.offset);
          }
          setVisibility({ hidden });
        }
        setBusy(false);
      };
      worker.onerror = () => {
        clearTimer();
        workerRef.current?.terminate();
        workerRef.current = null;
        setBusy(false);
      };
      workerRef.current = worker;
    }

    setBusy(true);
    armWatchdog();
    worker.postMessage(request);
  }, [armWatchdog, clearTimer]);

  sendRef.current = send;

  // Новый файл или кодировка: стили прошлого поколения к этим смещениям не относятся.
  useEffect(() => {
    sequenceRef.current += 1;
    pendingRef.current = null;
    lastRuleRef.current = null;
    skipRef.current = new Set();
    setStyleMap(new Map());
    setVisibility(null);
  }, [input.resetToken]);

  // Правка правила снимает локальный чёрный список: если владелец его «оживил»,
  // оно снова пойдёт в работу, а если паттерн всё ещё плохой — снова получит таймаут.
  // Заодно сбрасываем прошлый результат фильтра: он посчитан по старым правилам.
  useEffect(() => {
    skipRef.current = new Set();
    setVisibility(null);
  }, [input.rules, input.filters]);

  useEffect(() => {
    if (!input.enabled) {
      setBusy(false);
      setVisibility(null);
      return;
    }
    const timer = window.setTimeout(() => sendRef.current(), EVAL_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [input.enabled, input.lines, input.resetToken, input.rules, input.filters, input.activeTabId]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [],
  );

  const styleOf = useCallback((offset: number) => styleMap.get(offset) ?? null, [styleMap]);
  const hidden = useMemo(() => visibility?.hidden ?? null, [visibility]);

  return { styleOf, hidden, busy };
}
