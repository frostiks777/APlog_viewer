export interface LogLine {
  offset: number;
  text: string;
}

export interface LogPage {
  tabId: string;
  path: string;
  title: string;
  lines: LogLine[];
  endOffset: number;
  eof: boolean;
  size: number;
  mtimeMs: number;
  encoding: string;
  event: 'ok' | 'rotated' | 'truncated';
}

export interface TabState {
  id: string;
  path: string;
  title: string;
  encoding: string | null;
  tail: boolean;
  wrap: boolean;
  scrollOffset: number;
}

export interface HighlightRule {
  id: string;
  enabled: boolean;
  match: string;
  isRegex: boolean;
  caseSensitive: boolean;
  invert: boolean;
  fg: string;
  bg: string;
  bold: boolean;
  priority: number;
  scope: 'global' | 'tab';
  tabId: string | null;
  /** Правило не применяется: выражение не уложилось в бюджет времени. */
  disabledReason?: 'timeout' | null;
}

export interface FilterRule {
  id: string;
  enabled: boolean;
  mode: 'include' | 'exclude';
  match: string;
  isRegex: boolean;
  caseSensitive: boolean;
  tabId: string | null;
  disabledReason?: 'timeout' | null;
}

export interface PanelsState {
  rulesOpen: boolean;
  rulesWidth: number;
  rulesTab: 'highlight' | 'filters';
}

export interface SearchSettings {
  isRegex: boolean;
  caseSensitive: boolean;
}

export interface UiState {
  fontFamily: string;
  fontSize: number;
  rowHeight: number;
  theme: 'dark' | 'light';
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

export interface RuleIssue {
  id: string;
  message: string;
}

export interface SearchMatch {
  offset: number;
  endOffset: number;
  text: string;
}

export type SearchDirection = 'forward' | 'backward';

export interface SearchResult {
  tabId: string;
  path: string;
  title: string;
  encoding: string;
  event: 'ok' | 'rotated' | 'truncated';
  matches: SearchMatch[];
  /** Начало строки для продолжения в том же направлении. */
  cursor: number;
  eof: boolean;
  scannedBytes: number;
  size: number;
  timedOut: boolean;
}

export interface SearchParams {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  direction: SearchDirection;
  fromOffset: number;
  limit?: number;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    });
  } catch {
    // Браузерный TypeError «Failed to fetch» — не сообщение для пользователя.
    throw new Error('Сервер не отвечает — проверьте, запущен ли APlog Viewer');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  profile: () => request<Profile>('/api/v1/profile'),
  addTab: (path: string) =>
    request<TabState>('/api/v1/tabs', { method: 'POST', body: JSON.stringify({ path }) }),
  patchTab: (id: string, patch: Partial<TabState>) =>
    request<TabState>(`/api/v1/tabs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteTab: (id: string) => request<void>(`/api/v1/tabs/${id}`, { method: 'DELETE' }),
  activateTab: (id: string) => request<TabState>(`/api/v1/tabs/${id}/activate`, { method: 'POST' }),
  page: (id: string, offset: number, lines: number) =>
    request<LogPage>(`/api/v1/tabs/${id}/page?offset=${offset}&lines=${lines}`),
  lastPage: (id: string, lines: number) =>
    request<LogPage>(`/api/v1/tabs/${id}/last-page?lines=${lines}`),
  pageBefore: (id: string, offset: number, lines: number) =>
    request<LogPage>(`/api/v1/tabs/${id}/page-before?offset=${offset}&lines=${lines}`),
  tail: (id: string, offset: number) => request<LogPage>(`/api/v1/tabs/${id}/tail?offset=${offset}`),
  search: (id: string, params: SearchParams) =>
    request<SearchResult>(`/api/v1/tabs/${id}/search`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  putRules: (rules: HighlightRule[]) =>
    request<{ rules: HighlightRule[]; issues: RuleIssue[] }>('/api/v1/rules', {
      method: 'PUT',
      body: JSON.stringify({ rules }),
    }),
  putFilters: (filters: FilterRule[]) =>
    request<{ filters: FilterRule[]; issues: RuleIssue[] }>('/api/v1/filters', {
      method: 'PUT',
      body: JSON.stringify({ filters }),
    }),
  patchUi: (patch: Partial<UiState>) =>
    request<UiState>('/api/v1/ui', { method: 'PATCH', body: JSON.stringify(patch) }),
};
