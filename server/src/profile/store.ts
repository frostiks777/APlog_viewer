import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  /**
   * Правило включено пользователем, но не применяется: выражение не ответило за бюджет
   * времени. Признак хранится в профиле, иначе после перезагрузки страница снова
   * зависла бы на том же паттерне.
   */
  disabledReason?: 'timeout' | null;
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
  disabledReason?: 'timeout' | null;
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

export interface PanelsState {
  rulesOpen: boolean;
  /** Ширина выдвижной панели в пикселях. */
  rulesWidth: number;
  rulesTab: 'highlight' | 'filters';
}

/** Настройки поиска, которые переживают перезапуск: сам запрос не сохраняем. */
export interface SearchSettings {
  isRegex: boolean;
  caseSensitive: boolean;
}

export interface UiState {
  fontFamily: string;
  fontSize: number;
  rowHeight: number;
  theme: 'dark' | 'light';
  /** Автозапуск приложения при входе в систему. */
  autostart: boolean;
  panels: PanelsState;
  search: SearchSettings;
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
      autostart: false,
      panels: { rulesOpen: false, rulesWidth: 360, rulesTab: 'highlight' },
      search: { isRegex: false, caseSensitive: true },
    },
  };
}

let cache: Profile | null = null;
let writeChain: Promise<void> = Promise.resolve();

export async function loadProfile(): Promise<Profile> {
  if (cache) return cache;

  const read = async (file: string): Promise<Profile | null> => {
    try {
      const raw = await readFile(file, 'utf8');
      return normalizeProfile(JSON.parse(raw) as Partial<Profile>);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  };

  cache = (await read(PROFILE_FILE)) ?? (await read(`${PROFILE_FILE}.bak`)) ?? defaultProfile();
  return cache;
}

export async function saveProfile(next: Profile): Promise<Profile> {
  const normalized = normalizeProfile(next);
  cache = normalized;
  // Запись строго последовательная и атомарная: tmp + rename, чтобы не оставить
  // полузаписанный профиль при падении или параллельных запросах.
  writeChain = writeChain.then(async () => {
    await mkdir(PROFILE_DIR, { recursive: true });
    // Предыдущая версия остаётся как .bak: битый профиль не должен стирать настройки.
    await copyFile(PROFILE_FILE, `${PROFILE_FILE}.bak`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    });
    const tmp = `${PROFILE_FILE}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await replaceFile(tmp, PROFILE_FILE);
  });
  await writeChain;
  return normalized;
}

/**
 * Windows иногда отдаёт EPERM/EBUSY на rename поверх существующего файла —
 * антивирус или индексатор ещё держат хендл. Несколько коротких повторов решают это
 * без изменения атомарности; прямая перезапись — последний шанс.
 */
async function replaceFile(tmp: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(tmp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error;
      await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
  await copyFile(tmp, target);
  await rm(tmp, { force: true });
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

  const rules = normalizeRules(input.rules);
  const filters = normalizeFilters(input.filters);

  const inputUi = (input.ui ?? {}) as Partial<UiState>;
  const inputSearch = (inputUi.search ?? {}) as Partial<SearchSettings>;
  const ui: UiState = {
    // Поля перечисляем явно: спред сохранял бы в профиль ключи, которых больше нет в схеме
    // (например, showLineNumbers из первой версии).
    fontFamily: typeof inputUi.fontFamily === 'string' && inputUi.fontFamily ? inputUi.fontFamily : base.ui.fontFamily,
    fontSize: clampNumber(inputUi.fontSize, 8, 32, base.ui.fontSize),
    rowHeight: clampNumber(inputUi.rowHeight, 12, 48, base.ui.rowHeight),
    theme: inputUi.theme === 'light' ? 'light' : 'dark',
    autostart: Boolean(inputUi.autostart),
    panels: { ...base.ui.panels, ...(inputUi.panels ?? {}) },
    search: {
      isRegex: Boolean(inputSearch.isRegex),
      caseSensitive: inputSearch.caseSensitive !== false,
    },
  };
  ui.panels.rulesOpen = Boolean(ui.panels.rulesOpen);
  ui.panels.rulesWidth = clampNumber(ui.panels.rulesWidth, 300, 640, base.ui.panels.rulesWidth);
  ui.panels.rulesTab = ui.panels.rulesTab === 'filters' ? 'filters' : 'highlight';

  const activeTabId =
    typeof input.activeTabId === 'string' && tabs.some((tab) => tab.id === input.activeTabId)
      ? input.activeTabId
      : (tabs[0]?.id ?? null);

  return { version: 1, tabs, activeTabId, rules, filters, ui };
}

function normalizeRules(input: unknown): HighlightRule[] {
  if (!Array.isArray(input)) return DEFAULT_RULES.map((rule) => ({ ...rule }));

  const rules: HighlightRule[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const rule = item as Partial<HighlightRule>;
    if (typeof rule.match !== 'string') continue;
    const tabId = typeof rule.tabId === 'string' && rule.tabId ? rule.tabId : null;
    const scoped = rule.scope === 'tab' && tabId !== null;
    rules.push({
      id: typeof rule.id === 'string' && rule.id ? rule.id : newId(),
      enabled: Boolean(rule.enabled),
      // Паттерн длиннее 500 символов в логе всё равно бесполезен, а UI он разорвёт.
      match: rule.match.slice(0, 500),
      isRegex: Boolean(rule.isRegex),
      caseSensitive: Boolean(rule.caseSensitive),
      invert: Boolean(rule.invert),
      fg: normalizeColor(rule.fg, '#ffffff'),
      bg: normalizeColor(rule.bg, 'transparent'),
      bold: Boolean(rule.bold),
      priority: Math.trunc(clampNumber(rule.priority, -10_000, 10_000, 0)),
      scope: scoped ? 'tab' : 'global',
      tabId: scoped ? tabId : null,
      disabledReason: rule.disabledReason === 'timeout' ? 'timeout' : null,
    });
  }
  return rules;
}

function normalizeFilters(input: unknown): FilterRule[] {
  if (!Array.isArray(input)) return [];

  const filters: FilterRule[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const rule = item as Partial<FilterRule>;
    if (typeof rule.match !== 'string') continue;
    filters.push({
      id: typeof rule.id === 'string' && rule.id ? rule.id : newId(),
      enabled: Boolean(rule.enabled),
      mode: rule.mode === 'include' ? 'include' : 'exclude',
      match: rule.match.slice(0, 500),
      isRegex: Boolean(rule.isRegex),
      caseSensitive: Boolean(rule.caseSensitive),
      tabId: typeof rule.tabId === 'string' && rule.tabId ? rule.tabId : null,
      disabledReason: rule.disabledReason === 'timeout' ? 'timeout' : null,
    });
  }
  return filters;
}

/**
 * Цвет приходит из UI и из старых профилей. Принимаем только `#rgb`, `#rrggbb` и
 * `transparent`: произвольная CSS-строка в inline-style — это лишняя поверхность.
 */
function normalizeColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const color = value.trim().toLowerCase();
  if (color === 'transparent') return 'transparent';
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) {
    const r = color.charAt(1);
    const g = color.charAt(2);
    const b = color.charAt(3);
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
