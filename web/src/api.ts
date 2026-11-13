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
}

export interface FilterRule {
  id: string;
  enabled: boolean;
  mode: 'include' | 'exclude';
  match: string;
  isRegex: boolean;
  caseSensitive: boolean;
  tabId: string | null;
}

export interface Profile {
  version: 1;
  tabs: TabState[];
  activeTabId: string | null;
  rules: HighlightRule[];
  filters: FilterRule[];
  ui: {
    fontFamily: string;
    fontSize: number;
    rowHeight: number;
    theme: 'dark' | 'light';
    showLineNumbers: boolean;
    autostart: boolean;
  };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined;
  const response = await fetch(url, {
    ...init,
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
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
};
