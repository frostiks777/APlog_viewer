import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROFILE_DIR, PROFILE_FILE } from '../config.js';
import { isEncoding, type Encoding } from '../files/encoding.js';

export interface HighlightRule {
  id: string;
  enabled: boolean;
  /** Подстрока или регулярное выражение. */
  match: string;
  isRegex: boolean;
  caseSensitive: boolean;
  /** Инверсия цвета — полезно для «всё, кроме…». */
  invert: boolean;
  fg: string;
  bg: string;
  bold: boolean;
  /** Больше — выше приоритет при пересечении правил. */
  priority: number;
  /** global — правило профиля, tab — только для одной вкладки. */
  scope: 'global' | 'tab';
  tabId: string | null;
}

export type FilterMode = 'include' | 'exclude';

export interface FilterRule {
  id: string;
  enabled: boolean;
  mode: FilterMode;
  match: string;
  isRegex: boolean;
  caseSensitive: boolean;
  tabId: string | null;
}

export interface TabState {
  id: string;
  path: string;
  title: string;
  encoding: Encoding | null;
  tail: boolean;
  wrap: boolean;
  scrollOffset: number;
}

export interface UiState {
  fontFamily: string;
  fontSize: number;
  rowHeight: number;
  theme: 'dark' | 'light';
  showLineNumbers: boolean;
  /** Автозапуск приложения при входе в систему. */
  autostart: boolean;
}

export interface Profile {
  version: 1;
  tabs: TabState[];
  activeTabId: string | null;
  rules: HighlightRule[];
  filters: FilterRule[];
  ui: UiState;
}

export const DEFAULT_RULES: HighlightRule[] = [
  {
    id: 'rule-error',
    enabled: true,
    match: 'ERROR',
    isRegex: false,
    caseSensitive: true,
    invert: false,
    fg: '#ffffff',
    bg: '#b3261e',
    bold: true,
    priority: 100,
    scope: 'global',
    tabId: null,
  },
  {
    id: 'rule-warn',
    enabled: true,
    match: 'WARN',
    isRegex: false,
    caseSensitive: true,
    invert: false,
    fg: '#1a1a1a',
    bg: '#e0a800',
    bold: false,
    priority: 80,
    scope: 'global',
    tabId: null,
  },
  {
    id: 'rule-exception',
    enabled: true,
    match: 'Exception|Ошибка|не найден',
    isRegex: true,
    caseSensitive: false,
    invert: false,
    fg: '#ffb4ab',
    bg: 'transparent',
    bold: false,
    priority: 90,
    scope: 'global',
    tabId: null,
  },
  {
    id: 'rule-info',
    enabled: false,
    match: 'INFO',
    isRegex: false,
    caseSensitive: true,
    invert: false,
    fg: '#9aa4b2',
    bg: 'transparent',
    bold: false,
    priority: 10,
    scope: 'global',
    tabId: null,
  },
  {
    id: 'rule-debug',
    enabled: false,
    match: 'DEBUG',
    isRegex: false,
    caseSensitive: true,
    invert: false,
    fg: '#6b7280',
    bg: 'transparent',
    bold: false,
    priority: 5,
    scope: 'global',
    tabId: null,
  },
];

export function defaultProfile(): Profile {
  return {
    version: 1,
    tabs: [],
    activeTabId: null,
    rules: DEFAULT_RULES,
    filters: [],
    ui: {
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: 13,
      rowHeight: 20,
      theme: 'dark',
      showLineNumbers: true,
      autostart: false,
    },
  };
}

let cache: Profile | null = null;
let writeChain: Promise<void> = Promise.resolve();

export async function loadProfile(): Promise<Profile> {
  if (cache) return cache;
  try {
    const raw = await readFile(PROFILE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Profile>;
    cache = normalizeProfile(parsed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    cache = defaultProfile();
  }
  return cache;
}

export async function saveProfile(next: Profile): Promise<Profile> {
  const normalized = normalizeProfile(next);
  cache = normalized;
  // Запись строго последовательная и атомарная: tmp + rename, чтобы не оставить
  // полузаписанный профиль при падении или параллельных запросах.
  writeChain = writeChain.then(async () => {
    await mkdir(PROFILE_DIR, { recursive: true });
    const tmp = `${PROFILE_FILE}.tmp`;
    await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await rename(tmp, PROFILE_FILE);
  });
  await writeChain;
  return normalized;
}

export function newId(): string {
  return randomUUID();
}

export function assertAbsolutePath(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error('Путь должен быть абсолютным: UNC (\\\\host\\share\\...) или диск (C:\\...)');
  }
}

export async function pathAvailable(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

function normalizeProfile(input: Partial<Profile>): Profile {
  const base = defaultProfile();
  const tabs = Array.isArray(input.tabs)
    ? input.tabs
        .filter((tab): tab is TabState => Boolean(tab) && typeof (tab as TabState).path === 'string')
        .map((tab) => ({
          id: typeof tab.id === 'string' && tab.id ? tab.id : newId(),
          path: tab.path,
          title: typeof tab.title === 'string' && tab.title ? tab.title : basename(tab.path),
          encoding: isEncoding(tab.encoding) ? tab.encoding : null,
          tail: Boolean(tab.tail),
          wrap: Boolean(tab.wrap),
          scrollOffset: Number.isFinite(tab.scrollOffset) ? Math.max(0, tab.scrollOffset) : 0,
        }))
    : [];

  const rules = Array.isArray(input.rules)
    ? input.rules
        .filter((rule): rule is HighlightRule => Boolean(rule) && typeof (rule as HighlightRule).match === 'string')
        .map((rule) => ({ ...base.rules[0], ...rule, id: rule.id || newId() }))
    : base.rules;

  const filters = Array.isArray(input.filters)
    ? input.filters
        .filter((rule): rule is FilterRule => Boolean(rule) && typeof (rule as FilterRule).match === 'string')
        .map((rule) => {
          const mode: FilterMode = rule.mode === 'include' ? 'include' : 'exclude';
          return {
            id: rule.id || newId(),
            enabled: Boolean(rule.enabled),
            mode,
            match: rule.match,
            isRegex: Boolean(rule.isRegex),
            caseSensitive: Boolean(rule.caseSensitive),
            tabId: rule.tabId ?? null,
          };
        })
    : [];

  const ui: UiState = {
    ...base.ui,
    ...(input.ui ?? {}),
  };
  ui.fontSize = clampNumber(ui.fontSize, 8, 32, base.ui.fontSize);
  ui.rowHeight = clampNumber(ui.rowHeight, 12, 48, base.ui.rowHeight);
  ui.theme = ui.theme === 'light' ? 'light' : 'dark';

  const activeTabId =
    typeof input.activeTabId === 'string' && tabs.some((tab) => tab.id === input.activeTabId)
      ? input.activeTabId
      : (tabs[0]?.id ?? null);

  return { version: 1, tabs, activeTabId, rules, filters, ui };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
