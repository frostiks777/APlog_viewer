import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  api,
  type FilterRule,
  type HighlightRule,
  type LogLine,
  type PanelsState,
  type Profile,
  type SearchSettings,
  type TabState,
} from './api';
import RulesPanel, { type PanelTab } from './RulesPanel';
import { filterAppliesToTab } from './rules/evaluate';
import { useRulesEngine } from './rules/useRulesEngine';
import { useFileSearch } from './search/useFileSearch';
import { useSearchHits } from './search/useSearchHits';

const PAGE_LINES = 400;
const MAX_BUFFERED_LINES = 60_000;
/** Сколько строк максимум просматривает автофильтр, прежде чем попросить «продолжить». */
const FILTER_BUFFER_LIMIT = 20_000;
const ENCODINGS = ['utf-8', 'cp1251', 'cp866', 'utf-16le', 'utf-16be', 'latin1'] as const;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Отрицательные индексы тоже должны давать ровный шаг «каждые 10/100». */
function isMultiple(value: number, step: number): boolean {
  return ((value % step) + step) % step === 0;
}

function dotClass(position: number): string {
  if (isMultiple(position, 100)) return 'dot dot-100';
  if (isMultiple(position, 10)) return 'dot dot-10';
  return 'dot';
}

export default function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [endOffset, setEndOffset] = useState(0);
  const [eof, setEof] = useState(true);
  const [fileSize, setFileSize] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [notice, setNotice] = useState<string | null>(null);
  const [filterPaused, setFilterPaused] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [savingError, setSavingError] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const pendingScrollRef = useRef<'end' | null>(null);
  const atBottomRef = useRef(true);
  const reloadEndRef = useRef<() => void>(() => undefined);
  const savedSettingsRef = useRef({ rules: '', filters: '' });
  const savedUiRef = useRef('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const activeTabRef = useRef<TabState | null>(null);
  const linesRef = useRef<LogLine[]>([]);
  const revealedMatchRef = useRef('');
  const stateRef = useRef({ activeId, endOffset, eof, linesLength: 0, tail: false });
  stateRef.current = {
    activeId,
    endOffset,
    eof,
    linesLength: lines.length,
    tail: profile?.tabs.find((tab) => tab.id === activeId)?.tail ?? false,
  };

  const activeTab = profile?.tabs.find((tab) => tab.id === activeId) ?? null;
  const rowHeight = profile?.ui.rowHeight ?? 20;
  const panels: PanelsState = profile?.ui.panels ?? {
    rulesOpen: false,
    rulesWidth: 360,
    rulesTab: 'highlight',
  };
  const searchSettings: SearchSettings = profile?.ui.search ?? {
    isRegex: false,
    caseSensitive: true,
  };

  activeTabRef.current = activeTab;
  linesRef.current = lines;

  const applyPage = useCallback((page: Awaited<ReturnType<typeof api.page>>, mode: 'replace' | 'append') => {
    if (mode === 'append' && atBottomRef.current) pendingScrollRef.current = 'end';
    setLines((current) => {
      if (mode === 'replace') return page.lines;
      const next = [...current, ...page.lines];
      return next.length > MAX_BUFFERED_LINES ? next.slice(next.length - MAX_BUFFERED_LINES) : next;
    });
    setEndOffset(page.endOffset);
    setEof(page.eof);
    setFileSize(page.size);
  }, []);

  const loadEnd = useCallback(async (tab: TabState) => {
    loadingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const page = await api.lastPage(tab.id, PAGE_LINES);
      pendingScrollRef.current = 'end';
      setLines(page.lines);
      setEndOffset(page.endOffset);
      setEof(true);
      setFileSize(page.size);
      setScrollTop(0);
      setResetToken((token) => token + 1);
      if (logRef.current) logRef.current.scrollTop = 0;
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      loadingRef.current = false;
      setBusy(false);
    }
  }, []);

  const loadAt = useCallback(async (tab: TabState, offset: number) => {
    loadingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const page = await api.page(tab.id, offset, PAGE_LINES);
      setLines(page.lines);
      setEndOffset(page.endOffset);
      setEof(page.eof);
      setFileSize(page.size);
      setScrollTop(0);
      setResetToken((token) => token + 1);
      if (logRef.current) logRef.current.scrollTop = 0;
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      loadingRef.current = false;
      setBusy(false);
    }
  }, []);

  /**
   * Переход к совпадению. Если строка уже в буфере, её покажет эффект прокрутки;
   * иначе грузим страницу ровно с этого смещения — поиск работает по всему файлу.
   */
  const revealSearchOffset = useCallback(async (offset: number) => {
    if (linesRef.current.some((line) => line.offset === offset)) return;
    const tab = activeTabRef.current;
    if (!tab) return;

    try {
      const page = await api.page(tab.id, offset, PAGE_LINES);
      if (activeTabRef.current?.id !== tab.id) return;
      setLines(page.lines);
      setEndOffset(page.endOffset);
      setEof(page.eof);
      setFileSize(page.size);
      setScrollTop(0);
      setResetToken((token) => token + 1);
      if (logRef.current) logRef.current.scrollTop = 0;
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await api.profile();
        setProfile(loaded);
        savedSettingsRef.current = {
          rules: JSON.stringify(loaded.rules),
          filters: JSON.stringify(loaded.filters),
        };
        savedUiRef.current = JSON.stringify(loaded.ui);
        const first = loaded.tabs.find((tab) => tab.id === loaded.activeTabId) ?? loaded.tabs[0] ?? null;
        if (!first) return;
        setActiveId(first.id);
        // Открываем конец файла: это хвостовой просмотр, а не чтение с начала.
        if (first.tail) await loadEnd(first);
        else await loadAt(first, first.scrollOffset);
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, [loadAt, loadEnd]);

  useEffect(() => {
    const element = logRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, [activeId]);

  useEffect(() => {
    reloadEndRef.current = () => {
      if (activeTab) void loadEnd(activeTab);
    };
  }, [activeTab, loadEnd]);

  useEffect(() => {
    if (pendingScrollRef.current !== 'end') return;
    const element = logRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setScrollTop(element.scrollTop);
    pendingScrollRef.current = null;
  }, [lines]);

  const appendNext = useCallback(async () => {
    if (!activeId || eof || loadingRef.current) return;
    loadingRef.current = true;
    setBusy(true);
    try {
      const page = await api.page(activeId, endOffset, PAGE_LINES);
      if (page.lines.length > 0) applyPage(page, 'append');
      else {
        setEndOffset(page.endOffset);
        setEof(page.eof);
        setFileSize(page.size);
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      loadingRef.current = false;
      setBusy(false);
    }
  }, [activeId, applyPage, endOffset, eof]);

  const filters = profile?.filters ?? [];
  const rules = profile?.rules ?? [];

  const filtersActive = useMemo(
    () =>
      filters.some(
        (rule) =>
          rule.enabled && rule.disabledReason !== 'timeout' && filterAppliesToTab(rule, activeId),
      ),
    [filters, activeId],
  );

  const filtersActiveRef = useRef(filtersActive);
  filtersActiveRef.current = filtersActive;

  /**
   * `auto` — догрузка автофильтром: не трогаем scrollTop (иначе список прыгает) и не
   * пишем ошибку сети в шапку. Прокрутку компенсируем только при ручном «выше».
   */
  const loadPrevious = useCallback(
    async (auto = false) => {
      if (!activeId || loadingRef.current) return;
      const first = lines[0];
      if (!first || first.offset === 0) return;
      if (lines.length >= MAX_BUFFERED_LINES) return;
      loadingRef.current = true;
      setBusy(true);
      try {
        const page = await api.pageBefore(activeId, first.offset, PAGE_LINES);
        if (page.lines.length > 0) {
          setLines((current) => [...page.lines, ...current]);
          if (!auto && !filtersActiveRef.current) {
            const element = logRef.current;
            if (element) {
              element.scrollTop += page.lines.length * rowHeight;
              setScrollTop(element.scrollTop);
            }
          }
        }
      } catch (cause) {
        if (!auto) setError((cause as Error).message);
      } finally {
        loadingRef.current = false;
        setBusy(false);
      }
    },
    [activeId, lines, rowHeight],
  );

  // Хвост: опрос раз в 1.5 с, только когда вкладка в tail-режиме и мы уже в конце файла.
  useEffect(() => {
    if (!activeId || !activeTab?.tail) return;
    let stopped = false;

    const timer = window.setInterval(() => {
      const state = stateRef.current;
      if (stopped || !state.tail || !state.eof || !state.activeId) return;
      void (async () => {
        try {
          const page = await api.tail(state.activeId as string, state.endOffset);
          if (page.event !== 'ok') {
            setNotice(
              page.event === 'rotated'
                ? 'Файл ротирован — открываю новый'
                : 'Файл усечён — перечитываю с конца',
            );
            reloadEndRef.current();
            return;
          }
          if (page.lines.length === 0) {
            setFileSize(page.size);
            return;
          }
          applyPage(page, 'append');
        } catch {
          /* шара могла отвалиться — молчим, следующий тик повторит */
        }
      })();
    }, 1500);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeId, activeTab?.tail, applyPage]);

  const markSlowRule = useCallback((ruleId: string) => {
    setProfile((current) => {
      if (!current) return current;
      if (current.rules.some((rule) => rule.id === ruleId)) {
        return {
          ...current,
          rules: current.rules.map((rule) =>
            rule.id === ruleId ? { ...rule, disabledReason: 'timeout' } : rule,
          ),
        };
      }
      if (current.filters.some((rule) => rule.id === ruleId)) {
        return {
          ...current,
          filters: current.filters.map((rule) =>
            rule.id === ruleId ? { ...rule, disabledReason: 'timeout' } : rule,
          ),
        };
      }
      return current;
    });
  }, []);

  const engine = useRulesEngine({
    enabled: Boolean(activeId),
    rules,
    filters,
    activeTabId: activeId,
    lines,
    resetToken,
    onSlowRule: markSlowRule,
  });

  const displayLines = useMemo(() => {
    if (!filtersActive) return lines;
    const hidden = engine.hidden;
    if (!hidden) return lines;
    return lines.filter((line) => !hidden.has(line.offset));
  }, [filtersActive, engine.hidden, lines]);

  const rulesById = useMemo(() => new Map(rules.map((rule) => [rule.id, rule])), [rules]);

  const styleFor = useCallback(
    (offset: number): CSSProperties => {
      const ruleId = engine.styleOf(offset);
      if (!ruleId) return {};
      const rule = rulesById.get(ruleId);
      if (!rule) return {};
      const fg = rule.invert ? rule.bg : rule.fg;
      const bg = rule.invert ? rule.fg : rule.bg;
      return {
        color: fg === 'transparent' ? undefined : fg,
        background: bg === 'transparent' ? undefined : bg,
        fontWeight: rule.bold ? 600 : undefined,
      };
    },
    [engine.styleOf, rulesById],
  );

  const onScroll = useCallback(() => {
    const element = logRef.current;
    if (!element) return;
    const top = element.scrollTop;
    setScrollTop(top);
    atBottomRef.current = top + element.clientHeight >= element.scrollHeight - 4;
    if (top + element.clientHeight >= displayLines.length * rowHeight - rowHeight * 4) {
      void appendNext();
    }
    if (top < rowHeight * 3) void loadPrevious();
  }, [appendNext, displayLines.length, loadPrevious, rowHeight]);

  // Автодогрузка под фильтром: поднимаемся вверх, пока совпадений не хватает на экран,
  // не достигнут лимит буфера или не дошли до начала файла.
  useEffect(() => {
    if (!activeId || !filtersActive || filterPaused) return;
    if (loadingRef.current) return;
    if (lines.length >= FILTER_BUFFER_LIMIT) return;
    const first = lines[0];
    if (!first || first.offset === 0) return;
    const rowsOnScreen = Math.max(20, Math.ceil(viewportHeight / rowHeight));
    if (displayLines.length >= rowsOnScreen) return;
    void loadPrevious(true);
  }, [
    activeId,
    displayLines.length,
    filterPaused,
    filtersActive,
    lines,
    loadPrevious,
    rowHeight,
    viewportHeight,
  ]);

  // Позиция чтения — часть рабочего пространства. Привязываемся к первой видимой строке,
  // а не к началу буфера, и пишем редко: иначе каждое колесо — запись профиля.
  const anchorIndex = Math.min(
    Math.max(0, displayLines.length - 1),
    Math.max(0, Math.floor(scrollTop / rowHeight)),
  );
  const anchorOffset = displayLines[anchorIndex]?.offset ?? null;

  const search = useFileSearch({
    tabId: activeId,
    anchorOffset: anchorOffset ?? endOffset,
    isRegex: searchSettings.isRegex,
    caseSensitive: searchSettings.caseSensitive,
    onReveal: revealSearchOffset,
  });

  const searchHits = useSearchHits({
    tabId: activeId,
    query: search.query,
    isRegex: search.isRegex,
    caseSensitive: search.caseSensitive,
    lines,
  });

  /**
   * Строка текущего совпадения видна даже при активном фильтре: иначе переход
   * к найденной строке заканчивался бы пустым списком.
   */
  const renderLines = useMemo(() => {
    const match = search.match;
    if (!match) return displayLines;
    if (displayLines.some((line) => line.offset === match.offset)) return displayLines;

    // Строку ещё не загрузили — не подставляем обрезанный текст из ответа поиска.
    // После догрузки страницы совпадение появится в displayLines, и эффект прокрутит к нему.
    const actual = lines.find((line) => line.offset === match.offset);
    if (!actual) return displayLines;

    let at = displayLines.findIndex((line) => line.offset > match.offset);
    if (at < 0) at = displayLines.length;
    return [...displayLines.slice(0, at), actual, ...displayLines.slice(at)];
  }, [displayLines, lines, search.match]);

  useEffect(() => {
    const match = search.match;
    if (!match) return;
    const index = renderLines.findIndex((line) => line.offset === match.offset);
    if (index < 0) return;

    const token = `${match.offset}:${search.index}`;
    if (revealedMatchRef.current === token) return;
    revealedMatchRef.current = token;

    const element = logRef.current;
    if (!element) return;
    // Совпадение — в середину экрана: видно контекст до и после.
    const top = Math.max(0, index * rowHeight - Math.floor(element.clientHeight / 2) + rowHeight);
    element.scrollTop = top;
    setScrollTop(top);
  }, [renderLines, rowHeight, search.match, search.index]);

  // Новый запрос должен заново центрировать первое совпадение, даже если оно
  // оказалось тем же смещением, что и в прошлой сессии.
  useEffect(() => {
    revealedMatchRef.current = '';
  }, [activeId, search.query, searchSettings.isRegex, searchSettings.caseSensitive]);

  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F3') {
        event.preventDefault();
        if (!searchRef.current.query) {
          searchInputRef.current?.focus();
          return;
        }
        if (event.shiftKey) searchRef.current.prev();
        else searchRef.current.next();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        if (!activeTabRef.current) return;
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!activeTab || filtersActive || anchorOffset === null) return;
    const timer = window.setTimeout(() => {
      void api.patchTab(activeTab.id, { scrollOffset: anchorOffset }).catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [activeTab?.id, anchorOffset, filtersActive]);

  useEffect(() => {
    if (!profile) return;
    const uiJson = JSON.stringify(profile.ui);
    if (!savedUiRef.current) {
      savedUiRef.current = uiJson;
      return;
    }
    if (uiJson === savedUiRef.current) return;
    const timer = window.setTimeout(() => {
      savedUiRef.current = uiJson;
      void api.patchUi(profile.ui).catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [profile?.ui]);

  useEffect(() => {
    if (!profile) return;
    const rulesJson = JSON.stringify(profile.rules);
    const filtersJson = JSON.stringify(profile.filters);
    const rulesDirty = rulesJson !== savedSettingsRef.current.rules;
    const filtersDirty = filtersJson !== savedSettingsRef.current.filters;
    if (!rulesDirty && !filtersDirty) return;

    setSaving('saving');
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (rulesDirty) {
            const result = await api.putRules(profile.rules);
            savedSettingsRef.current.rules = JSON.stringify(result.rules);
          }
          if (filtersDirty) {
            const result = await api.putFilters(profile.filters);
            savedSettingsRef.current.filters = JSON.stringify(result.filters);
          }
          setSaving('saved');
          setSavingError(null);
        } catch (cause) {
          setSaving('error');
          setSavingError((cause as Error).message);
        }
      })();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [profile?.rules, profile?.filters]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--panel-width',
      panels.rulesOpen ? `${panels.rulesWidth}px` : '0px',
    );
  }, [panels.rulesOpen, panels.rulesWidth]);

  const addTab = async () => {
    const path = pathInput.trim();
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const tab = await api.addTab(path);
      const next = await api.profile();
      setProfile(next);
      setActiveId(tab.id);
      setPathInput('');
      await loadEnd(tab);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const selectTab = async (tab: TabState) => {
    setActiveId(tab.id);
    await api.activateTab(tab.id).catch(() => undefined);
    if (tab.tail) await loadEnd(tab);
    else await loadAt(tab, tab.scrollOffset);
  };

  const closeTab = async (tab: TabState) => {
    await api.deleteTab(tab.id).catch(() => undefined);
    const next = await api.profile();
    setProfile(next);
    if (activeId === tab.id) {
      const fallback = next.tabs[0] ?? null;
      setActiveId(fallback?.id ?? null);
      if (fallback) {
        if (fallback.tail) await loadEnd(fallback);
        else await loadAt(fallback, fallback.scrollOffset);
      } else {
        setLines([]);
        setResetToken((token) => token + 1);
      }
    }
  };

  const patchActive = async (patch: Partial<TabState> & { encoding?: string | null }) => {
    if (!activeTab) return;
    const updated = await api.patchTab(activeTab.id, patch).catch((cause: Error) => {
      setError(cause.message);
      return null;
    });
    if (!updated) return;
    setProfile((current) =>
      current
        ? { ...current, tabs: current.tabs.map((tab) => (tab.id === updated.id ? updated : tab)) }
        : current,
    );
    if ('encoding' in patch) await loadEnd(updated);
  };

  const updatePanels = (patch: Partial<PanelsState>) => {
    setProfile((current) =>
      current
        ? {
            ...current,
            ui: { ...current.ui, panels: { ...current.ui.panels, ...patch } },
          }
        : current,
    );
  };

  const updateSearchSettings = (patch: Partial<SearchSettings>) => {
    setProfile((current) =>
      current
        ? { ...current, ui: { ...current.ui, search: { ...current.ui.search, ...patch } } }
        : current,
    );
  };

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 12);
  const end = Math.min(renderLines.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + 12);
  const visibleRows = renderLines.slice(start, end);
  const atEnd =
    eof && renderLines.length > 0 && scrollTop + viewportHeight >= renderLines.length * rowHeight - rowHeight * 2;
  const filterLimitReached = filtersActive && lines.length >= FILTER_BUFFER_LIMIT;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">AP</span>
          <span>APlog Viewer</span>
        </div>

        <form
          className="add-form"
          onSubmit={(event) => {
            event.preventDefault();
            void addTab();
          }}
        >
          <input
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            placeholder="\\server\c$\logs\app.log"
            spellCheck={false}
          />
          <button type="submit" disabled={busy}>
            +
          </button>
        </form>

        <nav className="tabs">
          {profile?.tabs.map((tab) => (
            <div key={tab.id} className={`tab ${tab.id === activeId ? 'tab-active' : ''}`}>
              <button className="tab-open" onClick={() => void selectTab(tab)} title={tab.path}>
                <span className="tab-title">{tab.title}</span>
                <span className="tab-path">{tab.path}</span>
              </button>
              <button className="tab-close" onClick={() => void closeTab(tab)} title="Закрыть">
                ×
              </button>
            </div>
          ))}
          {profile && profile.tabs.length === 0 && (
            <p className="hint">
              Добавьте путь к логу. Поддерживаются сетевые шары: <code>\\host\c$\...</code>
            </p>
          )}
        </nav>
      </aside>

      <main className="main">
        <header className="toolbar">
          <div className="toolbar-title">
            {activeTab ? activeTab.title : 'Лог не открыт'}
            {activeTab && <span className="muted">{formatSize(fileSize)}</span>}
          </div>

          {activeTab && (
            <div className="toolbar-controls">
              <label className="control">
                Кодировка
                <select
                  value={activeTab.encoding ?? 'auto'}
                  onChange={(event) =>
                    void patchActive({
                      encoding: event.target.value === 'auto' ? null : event.target.value,
                    })
                  }
                >
                  <option value="auto">авто</option>
                  {ENCODINGS.map((encoding) => (
                    <option key={encoding} value={encoding}>
                      {encoding}
                    </option>
                  ))}
                </select>
              </label>

              <label className="control checkbox">
                <input
                  type="checkbox"
                  checked={activeTab.tail}
                  onChange={(event) => void patchActive({ tail: event.target.checked })}
                />
                следить
              </label>

              <button
                className="control"
                onClick={() => void loadPrevious()}
                disabled={busy || !lines[0] || lines[0].offset === 0}
              >
                выше
              </button>

              <button className="control" onClick={() => void loadEnd(activeTab)} disabled={busy}>
                в конец
              </button>

              <button className="control" onClick={() => void loadAt(activeTab, 0)} disabled={busy}>
                в начало
              </button>

              <button
                className={`control ${panels.rulesOpen ? 'control-active' : ''}`}
                onClick={() => updatePanels({ rulesOpen: !panels.rulesOpen })}
                title="Правила подсветки и фильтры"
              >
                правила
              </button>
            </div>
          )}
        </header>

        {activeTab && (
          <div className="search-bar">
            <input
              ref={searchInputRef}
              className="search-input"
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (event.shiftKey) search.prev();
                  else search.next();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  search.clear();
                  event.currentTarget.blur();
                }
              }}
              placeholder="поиск по файлу…"
              spellCheck={false}
              aria-label="Поиск по файлу"
            />
            <button
              className={`chip ${searchSettings.isRegex ? 'chip-on' : ''}`}
              title="Регулярное выражение"
              onClick={() => updateSearchSettings({ isRegex: !searchSettings.isRegex })}
            >
              .*
            </button>
            <button
              className={`chip ${searchSettings.caseSensitive ? 'chip-on' : ''}`}
              title="Учитывать регистр"
              onClick={() => updateSearchSettings({ caseSensitive: !searchSettings.caseSensitive })}
            >
              Aa
            </button>
            <button
              className="control"
              title="Предыдущее совпадение (Shift+F3)"
              onClick={search.prev}
              disabled={search.busy || !search.query}
            >
              ↑
            </button>
            <button
              className="control"
              title="Следующее совпадение (F3)"
              onClick={search.next}
              disabled={search.busy || !search.query}
            >
              ↓
            </button>
            <span className="search-count">
              {search.busy
                ? 'поиск…'
                : search.total > 0
                  ? `${search.index + 1} / ${search.total}${search.complete ? '' : '+'}`
                  : search.tried && search.complete
                    ? 'не найдено'
                    : ''}
            </span>
            {search.error && <span className="search-error">{search.error}</span>}
            {!search.error && search.notice && <span className="muted">{search.notice}</span>}
            {!search.error && searchHits.timedOut && (
              <span className="muted">подсветка совпадений отключена — измените запрос</span>
            )}
            {search.query && (
              <button className="rule-remove" title="Очистить поиск" onClick={search.clear}>
                ×
              </button>
            )}
          </div>
        )}

        {error && <div className="error">{error}</div>}

        {filtersActive && (
          <div className="filter-bar">
            <span>
              фильтр: {renderLines.length.toLocaleString('ru-RU')} из{' '}
              {lines.length.toLocaleString('ru-RU')} строк буфера
            </span>
            {filterLimitReached && <span className="muted">лимит автодогрузки</span>}
            {engine.busy && <span className="busy">…</span>}
            {(lines[0]?.offset ?? 0) > 0 && lines.length < FILTER_BUFFER_LIMIT && (
              <button className="control" onClick={() => setFilterPaused((paused) => !paused)}>
                {filterPaused ? 'продолжить' : 'стоп'}
              </button>
            )}
          </div>
        )}

        <div className="log" ref={logRef} onScroll={onScroll}>
          <div className="spacer" style={{ height: renderLines.length * rowHeight }}>
            {visibleRows.map((line, index) => (
              <div
                key={line.offset}
                className={`row ${searchHits.hits?.has(line.offset) ? 'row-hit' : ''} ${
                  search.match?.offset === line.offset ? 'row-current' : ''
                }`}
                style={{ top: (start + index) * rowHeight, height: rowHeight, ...styleFor(line.offset) }}
              >
                <span className={dotClass(start + index)} />
                <span className="text">{line.text || ' '}</span>
              </div>
            ))}
          </div>
          {activeTab && filtersActive && renderLines.length === 0 && (
            <div className="empty">
              Нет совпадений в загруженном буфере
              {lines[0] && lines[0].offset > 0 ? ' — прокрутите вверх или снимите паузу' : ''}
            </div>
          )}
          {!activeTab && <div className="empty">Выберите вкладку или добавьте файл слева</div>}
        </div>

        <footer className="status">
          <span>строк в буфере: {lines.length.toLocaleString('ru-RU')}</span>
          {filtersActive && <span>показано: {renderLines.length.toLocaleString('ru-RU')}</span>}
          <span>смещение: {endOffset.toLocaleString('ru-RU')} Б</span>
          <span>{atEnd ? 'конец файла' : eof ? 'конец прочитан' : 'загружено частично'}</span>
          {notice && <span className="notice">{notice}</span>}
          {busy && <span className="busy">…</span>}
        </footer>
      </main>

      <RulesPanel
        open={panels.rulesOpen}
        width={panels.rulesWidth}
        tab={panels.rulesTab}
        rules={rules}
        filters={filters}
        tabs={profile?.tabs ?? []}
        activeTabId={activeId}
        saving={saving}
        savingError={savingError}
        onTabChange={(tab: PanelTab) => updatePanels({ rulesTab: tab })}
        onRulesChange={(next: HighlightRule[]) =>
          setProfile((current) => (current ? { ...current, rules: next } : current))
        }
        onFiltersChange={(next: FilterRule[]) =>
          setProfile((current) => (current ? { ...current, filters: next } : current))
        }
        onWidthChange={(width) => updatePanels({ rulesWidth: Math.round(width) })}
        onClose={() => updatePanels({ rulesOpen: false })}
      />
    </div>
  );
}
