import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type HighlightRule, type LogLine, type Profile, type TabState } from './api';

const PAGE_LINES = 400;
const MAX_BUFFERED_LINES = 60_000;
const ENCODINGS = ['utf-8', 'cp1251', 'cp866', 'utf-16le', 'utf-16be', 'latin1'] as const;

interface DisplayLine extends LogLine {
  n: number | null;
}

type Matcher = (text: string) => boolean;

function ruleMatcher(rule: HighlightRule): Matcher | null {
  try {
    if (rule.isRegex) {
      const re = new RegExp(rule.match, rule.caseSensitive ? '' : 'i');
      return (text) => re.test(text);
    }
    if (!rule.match) return null;
    const needle = rule.caseSensitive ? rule.match : rule.match.toLowerCase();
    return rule.caseSensitive ? (text) => text.includes(needle) : (text) => text.toLowerCase().includes(needle);
  } catch {
    return null;
  }
}

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

export default function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [lines, setLines] = useState<DisplayLine[]>([]);
  const [endOffset, setEndOffset] = useState(0);
  const [eof, setEof] = useState(true);
  const [fileSize, setFileSize] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  const logRef = useRef<HTMLDivElement>(null);
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

  const loadFirstPage = useCallback(async (tab: TabState, offset = 0) => {
    setBusy(true);
    setError(null);
    try {
      const page = await api.page(tab.id, offset, PAGE_LINES);
      setLines(page.lines.map((line, index) => ({ ...line, n: offset === 0 ? index + 1 : null })));
      setEndOffset(page.endOffset);
      setEof(page.eof);
      setFileSize(page.size);
      if (logRef.current) logRef.current.scrollTop = 0;
      setScrollTop(0);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await api.profile();
        setProfile(loaded);
        const first = loaded.tabs.find((tab) => tab.id === loaded.activeTabId) ?? loaded.tabs[0] ?? null;
        if (first) {
          setActiveId(first.id);
          await loadFirstPage(first, first.scrollOffset);
        }
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, [loadFirstPage]);

  useEffect(() => {
    const element = logRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, [activeId]);

  const appendNext = useCallback(async () => {
    if (!activeId || eof || busy) return;
    setBusy(true);
    try {
      const page = await api.page(activeId, endOffset, PAGE_LINES);
      if (page.lines.length > 0) {
        setLines((current) => {
          const next = [...current, ...page.lines.map((line) => ({ ...line, n: null }))];
          return next.length > MAX_BUFFERED_LINES ? next.slice(next.length - MAX_BUFFERED_LINES) : next;
        });
      }
      setEndOffset(page.endOffset);
      setEof(page.eof);
      setFileSize(page.size);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }, [activeId, busy, endOffset, eof]);

  const loadPrevious = useCallback(async () => {
    if (!activeId || busy) return;
    const first = lines[0];
    if (!first || first.offset === 0) return;
    setBusy(true);
    try {
      const page = await api.pageBefore(activeId, first.offset, PAGE_LINES);
      if (page.lines.length > 0) {
        setLines((current) => [...page.lines.map((line) => ({ ...line, n: null })), ...current]);
        const element = logRef.current;
        if (element) {
          const delta = page.lines.length * rowHeight;
          element.scrollTop += delta;
          setScrollTop(element.scrollTop);
        }
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }, [activeId, busy, lines, rowHeight]);

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
          if (page.lines.length === 0) {
            setFileSize(page.size);
            return;
          }
          setLines((current) => {
            const next = [...current, ...page.lines.map((line) => ({ ...line, n: null }))];
            return next.length > MAX_BUFFERED_LINES ? next.slice(next.length - MAX_BUFFERED_LINES) : next;
          });
          setEndOffset(page.endOffset);
          setEof(page.eof);
          setFileSize(page.size);
        } catch {
          /* шара могла отвалиться — молчим, следующий тик повторит */
        }
      })();
    }, 1500);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeId, activeTab?.tail]);

  const onScroll = useCallback(() => {
    const element = logRef.current;
    if (!element) return;
    const top = element.scrollTop;
    setScrollTop(top);
    const nearBottom = top + element.clientHeight >= lines.length * rowHeight - rowHeight * 4;
    if (nearBottom) void appendNext();
  }, [appendNext, lines.length, rowHeight]);

  const matchers = useMemo(() => {
    if (!profile) return [] as Array<{ rule: HighlightRule; test: Matcher }>;
    return profile.rules
      .filter((rule) => rule.enabled && (rule.scope === 'global' || rule.tabId === activeId))
      .sort((a, b) => b.priority - a.priority)
      .map((rule) => ({ rule, test: ruleMatcher(rule) }))
      .filter((item): item is { rule: HighlightRule; test: Matcher } => item.test !== null);
  }, [profile, activeId]);

  const styleFor = useCallback(
    (text: string): React.CSSProperties => {
      for (const { rule, test } of matchers) {
        if (!test(text)) continue;
        const fg = rule.invert ? rule.bg : rule.fg;
        const bg = rule.invert ? rule.fg : rule.bg;
        return {
          color: fg === 'transparent' ? undefined : fg,
          background: bg === 'transparent' ? undefined : bg,
          fontWeight: rule.bold ? 600 : undefined,
        };
      }
      return {};
    },
    [matchers],
  );

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
      await loadFirstPage(tab, 0);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const selectTab = async (tab: TabState) => {
    setActiveId(tab.id);
    await api.activateTab(tab.id).catch(() => undefined);
    await loadFirstPage(tab, tab.scrollOffset);
  };

  const closeTab = async (tab: TabState) => {
    await api.deleteTab(tab.id).catch(() => undefined);
    const next = await api.profile();
    setProfile(next);
    if (activeId === tab.id) {
      const fallback = next.tabs[0] ?? null;
      setActiveId(fallback?.id ?? null);
      if (fallback) await loadFirstPage(fallback, fallback.scrollOffset);
      else setLines([]);
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
    if ('encoding' in patch) await loadFirstPage(updated, 0);
  };

  const firstLine = lines[0];
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 12);
  const end = Math.min(lines.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + 12);
  const visible = lines.slice(start, end);

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

              <button className="control" onClick={() => void loadFirstPage(activeTab, 0)} disabled={busy}>
                перечитать
              </button>
            </div>
          )}
        </header>

        {error && <div className="error">{error}</div>}

        <div className="log" ref={logRef} onScroll={onScroll}>
          {firstLine && firstLine.offset > 0 && (
            <button className="load-prev" onClick={() => void loadPrevious()}>
              ↑ загрузить выше
            </button>
          )}
          <div className="spacer" style={{ height: lines.length * rowHeight }}>
            {visible.map((line, index) => {
              const position = start + index;
              return (
                <div
                  key={`${line.offset}-${position}`}
                  className="row"
                  style={{ top: position * rowHeight, height: rowHeight, ...styleFor(line.text) }}
                >
                  {profile?.ui.showLineNumbers && line.n !== null && <span className="ln">{line.n}</span>}
                  <span className="text">{line.text || ' '}</span>
                </div>
              );
            })}
          </div>
          {!activeTab && <div className="empty">Выберите вкладку или добавьте файл слева</div>}
        </div>

        <footer className="status">
          <span>строк в буфере: {lines.length.toLocaleString('ru-RU')}</span>
          <span>смещение: {endOffset.toLocaleString('ru-RU')} Б</span>
          <span>{eof ? 'конец файла' : 'загружено частично'}</span>
          {busy && <span className="busy">…</span>}
        </footer>
      </main>
    </div>
  );
}
