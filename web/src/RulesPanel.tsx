import { useMemo, type PointerEvent as ReactPointerEvent } from 'react';
import type { FilterRule, HighlightRule, TabState } from './api';

export type PanelTab = 'highlight' | 'filters';

interface RulesPanelProps {
  open: boolean;
  width: number;
  tab: PanelTab;
  rules: HighlightRule[];
  filters: FilterRule[];
  tabs: TabState[];
  activeTabId: string | null;
  saving: 'idle' | 'saving' | 'saved' | 'error';
  savingError: string | null;
  onTabChange: (tab: PanelTab) => void;
  onRulesChange: (rules: HighlightRule[]) => void;
  onFiltersChange: (filters: FilterRule[]) => void;
  onWidthChange: (width: number) => void;
  onClose: () => void;
}

const FALLBACK_COLOR = '#888888';

function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toColorInput(value: string): string {
  return value === 'transparent' ? FALLBACK_COLOR : value;
}

function byPriority(left: HighlightRule, right: HighlightRule): number {
  return right.priority - left.priority;
}

/** Перестановка вверх/вниз: приоритеты пересчитываются по позиции, без дыр и дублей. */
function moveRule(rules: HighlightRule[], id: string, direction: -1 | 1): HighlightRule[] {
  const sorted = [...rules].sort(byPriority);
  const index = sorted.findIndex((rule) => rule.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= sorted.length) return rules;

  const [moved] = sorted.splice(index, 1);
  if (!moved) return rules;
  sorted.splice(target, 0, moved);
  return sorted.map((rule, position) => ({ ...rule, priority: (sorted.length - position) * 10 }));
}

function scopeValue(rule: { scope?: 'global' | 'tab'; tabId: string | null }, tabs: TabState[]): string {
  if (rule.scope !== 'tab') return '';
  return tabs.some((tab) => tab.id === rule.tabId) ? (rule.tabId as string) : '';
}

function tabScopeValue(tabId: string | null, tabs: TabState[]): string {
  return tabId && tabs.some((tab) => tab.id === tabId) ? tabId : '';
}

function ScopeSelect({
  value,
  tabs,
  onChange,
}: {
  value: string;
  tabs: TabState[];
  onChange: (value: string) => void;
}) {
  return (
    <select className="rule-scope" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">все вкладки</option>
      {tabs.map((tab) => (
        <option key={tab.id} value={tab.id}>
          только «{tab.title}»
        </option>
      ))}
    </select>
  );
}

export default function RulesPanel({
  open,
  width,
  tab,
  rules,
  filters,
  tabs,
  activeTabId,
  saving,
  savingError,
  onTabChange,
  onRulesChange,
  onFiltersChange,
  onWidthChange,
  onClose,
}: RulesPanelProps) {
  const issues = useMemo(() => {
    const map = new Map<string, string>();
    for (const rule of [...rules, ...filters]) {
      if (!rule.isRegex || !rule.match) continue;
      try {
        new RegExp(rule.match);
      } catch (cause) {
        map.set(rule.id, (cause as Error).message);
      }
    }
    return map;
  }, [rules, filters]);

  const sortedRules = useMemo(() => [...rules].sort(byPriority), [rules]);
  const orderedFilters = useMemo(
    () => [...filters].sort((left, right) => (left.mode === right.mode ? 0 : left.mode === 'include' ? -1 : 1)),
    [filters],
  );

  const updateRule = (id: string, patch: Partial<HighlightRule>) => {
    onRulesChange(rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  };

  const updateFilter = (id: string, patch: Partial<FilterRule>) => {
    onFiltersChange(filters.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  };

  const addRule = () => {
    const highest = rules.reduce((max, rule) => Math.max(max, rule.priority), 0);
    onRulesChange([
      ...rules,
      {
        id: newId('rule'),
        enabled: true,
        match: '',
        isRegex: false,
        caseSensitive: true,
        invert: false,
        fg: '#ffffff',
        bg: '#2d3b55',
        bold: false,
        priority: highest + 10,
        scope: 'global',
        tabId: null,
        disabledReason: null,
      },
    ]);
  };

  const addFilter = () => {
    onFiltersChange([
      ...filters,
      {
        id: newId('filter'),
        enabled: true,
        mode: 'include',
        match: '',
        isRegex: false,
        caseSensitive: true,
        tabId: null,
        disabledReason: null,
      },
    ]);
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let nextWidth = startWidth;

    const move = (moveEvent: PointerEvent) => {
      nextWidth = Math.min(640, Math.max(300, startWidth + (startX - moveEvent.clientX)));
      document.documentElement.style.setProperty('--panel-width', `${nextWidth}px`);
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      onWidthChange(nextWidth);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
  };

  const enabledRules = rules.filter((rule) => rule.enabled && rule.disabledReason !== 'timeout').length;
  const enabledFilters = filters.filter((rule) => rule.enabled && rule.disabledReason !== 'timeout').length;

  return (
    <section className={`rules-panel ${open ? 'rules-panel-open' : ''}`} aria-hidden={!open}>
      <div className="panel-resizer" onPointerDown={startResize} title="Потяните, чтобы изменить ширину" />
      <header className="panel-head">
        <div className="panel-tabs">
          <button
            className={`panel-tab ${tab === 'highlight' ? 'panel-tab-active' : ''}`}
            onClick={() => onTabChange('highlight')}
          >
            Подсветка
          </button>
          <button
            className={`panel-tab ${tab === 'filters' ? 'panel-tab-active' : ''}`}
            onClick={() => onTabChange('filters')}
          >
            Фильтры
          </button>
        </div>
        <button className="panel-close" onClick={onClose} title="Закрыть панель">
          ×
        </button>
      </header>

      <div className="panel-body">
        {tab === 'highlight' ? (
          <>
            <p className="panel-hint">
              Правила применяются сверху вниз: первое совпадение задаёт цвет строки.
            </p>
            {sortedRules.map((rule, index) => {
              const issue = issues.get(rule.id);
              return (
                <article
                  key={rule.id}
                  className={`rule ${rule.enabled ? '' : 'rule-off'} ${issue ? 'rule-bad' : ''}`}
                >
                  <div className="rule-line">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })}
                      title="Включено"
                    />
                    <input
                      className="rule-match"
                      value={rule.match}
                      spellCheck={false}
                      placeholder={rule.isRegex ? 'ERROR|Exception' : 'ERROR'}
                      onChange={(event) => updateRule(rule.id, { match: event.target.value })}
                    />
                    <button
                      className={`chip ${rule.isRegex ? 'chip-on' : ''}`}
                      title="Регулярное выражение"
                      onClick={() => updateRule(rule.id, { isRegex: !rule.isRegex })}
                    >
                      .*
                    </button>
                    <button
                      className={`chip ${rule.caseSensitive ? 'chip-on' : ''}`}
                      title="Учитывать регистр"
                      onClick={() => updateRule(rule.id, { caseSensitive: !rule.caseSensitive })}
                    >
                      Aa
                    </button>
                    <button className="rule-remove" title="Удалить правило" onClick={() => onRulesChange(rules.filter((item) => item.id !== rule.id))}>
                      ×
                    </button>
                  </div>

                  <div className="rule-line rule-meta">
                    <label className="color-field" title="Цвет текста">
                      <span>текст</span>
                      <input
                        type="color"
                        value={toColorInput(rule.fg)}
                        onChange={(event) => updateRule(rule.id, { fg: event.target.value })}
                      />
                      <button
                        className={`chip ${rule.fg === 'transparent' ? 'chip-on' : ''}`}
                        title="Не менять цвет текста"
                        onClick={() => updateRule(rule.id, { fg: 'transparent' })}
                      >
                        нет
                      </button>
                    </label>

                    <label className="color-field" title="Цвет фона">
                      <span>фон</span>
                      <input
                        type="color"
                        value={toColorInput(rule.bg)}
                        onChange={(event) => updateRule(rule.id, { bg: event.target.value })}
                      />
                      <button
                        className={`chip ${rule.bg === 'transparent' ? 'chip-on' : ''}`}
                        title="Без фона"
                        onClick={() => updateRule(rule.id, { bg: 'transparent' })}
                      >
                        нет
                      </button>
                    </label>

                    <button
                      className={`chip ${rule.bold ? 'chip-on' : ''}`}
                      title="Жирный текст"
                      onClick={() => updateRule(rule.id, { bold: !rule.bold })}
                    >
                      Ж
                    </button>

                    <ScopeSelect
                      value={scopeValue(rule, tabs)}
                      tabs={tabs}
                      onChange={(value) =>
                        updateRule(rule.id, {
                          scope: value ? 'tab' : 'global',
                          tabId: value || null,
                        })
                      }
                    />

                    <span className="rule-order">
                      <button
                        title="Выше приоритет"
                        disabled={index === 0}
                        onClick={() => onRulesChange(moveRule(rules, rule.id, -1))}
                      >
                        ↑
                      </button>
                      <button
                        title="Ниже приоритет"
                        disabled={index === sortedRules.length - 1}
                        onClick={() => onRulesChange(moveRule(rules, rule.id, 1))}
                      >
                        ↓
                      </button>
                    </span>
                  </div>

                  {issue && <div className="rule-issue">ошибка в выражении: {issue}</div>}
                  {rule.disabledReason === 'timeout' && (
                    <div className="rule-issue">
                      отключено: выражение слишком медленное.{' '}
                      <button
                        className="link-button"
                        onClick={() => updateRule(rule.id, { disabledReason: null })}
                      >
                        включить снова
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
            <button className="panel-add" onClick={addRule}>
              + правило
            </button>
          </>
        ) : (
          <>
            <p className="panel-hint">
              Include оставляет только совпавшие строки, exclude убирает совпавшие. Пустой include
              ничего не ограничивает.
            </p>
            {orderedFilters.map((rule) => {
              const issue = issues.get(rule.id);
              return (
                <article
                  key={rule.id}
                  className={`rule ${rule.enabled ? '' : 'rule-off'} ${issue ? 'rule-bad' : ''}`}
                >
                  <div className="rule-line">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(event) => updateFilter(rule.id, { enabled: event.target.checked })}
                      title="Включено"
                    />
                    <select
                      className="rule-mode"
                      value={rule.mode}
                      onChange={(event) =>
                        updateFilter(rule.id, { mode: event.target.value === 'exclude' ? 'exclude' : 'include' })
                      }
                    >
                      <option value="include">показывать</option>
                      <option value="exclude">скрывать</option>
                    </select>
                    <input
                      className="rule-match"
                      value={rule.match}
                      spellCheck={false}
                      placeholder={rule.isRegex ? 'ERROR|Exception' : 'ERROR'}
                      onChange={(event) => updateFilter(rule.id, { match: event.target.value })}
                    />
                    <button
                      className={`chip ${rule.isRegex ? 'chip-on' : ''}`}
                      title="Регулярное выражение"
                      onClick={() => updateFilter(rule.id, { isRegex: !rule.isRegex })}
                    >
                      .*
                    </button>
                    <button
                      className={`chip ${rule.caseSensitive ? 'chip-on' : ''}`}
                      title="Учитывать регистр"
                      onClick={() => updateFilter(rule.id, { caseSensitive: !rule.caseSensitive })}
                    >
                      Aa
                    </button>
                    <button
                      className="rule-remove"
                      title="Удалить фильтр"
                      onClick={() => onFiltersChange(filters.filter((item) => item.id !== rule.id))}
                    >
                      ×
                    </button>
                  </div>

                  <div className="rule-line rule-meta">
                    <ScopeSelect
                      value={tabScopeValue(rule.tabId, tabs)}
                      tabs={tabs}
                      onChange={(value) => updateFilter(rule.id, { tabId: value || null })}
                    />
                  </div>

                  {issue && <div className="rule-issue">ошибка в выражении: {issue}</div>}
                  {rule.disabledReason === 'timeout' && (
                    <div className="rule-issue">
                      отключено: выражение слишком медленное.{' '}
                      <button
                        className="link-button"
                        onClick={() => updateFilter(rule.id, { disabledReason: null })}
                      >
                        включить снова
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
            <button className="panel-add" onClick={addFilter}>
              + фильтр
            </button>
          </>
        )}
      </div>

      <footer className="panel-foot">
        <span>
          правил: {enabledRules} · фильтров: {enabledFilters}
        </span>
        {saving === 'saving' && <span className="busy">сохранение…</span>}
        {saving === 'saved' && <span className="saved">сохранено</span>}
        {saving === 'error' && <span className="rule-issue">ошибка сохранения: {savingError}</span>}
        {activeTabId && <span className="muted">{tabs.find((tab) => tab.id === activeTabId)?.title}</span>}
      </footer>
    </section>
  );
}
