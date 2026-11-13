import type { FastifyInstance } from 'fastify';
import { DEFAULT_PAGE_LINES, MAX_PAGE_LINES } from '../config.js';
import { isEncoding } from '../files/encoding.js';
import type { LogFilePool } from '../files/reader.js';
import {
  assertAbsolutePath,
  loadProfile,
  newId,
  pathAvailable,
  saveProfile,
  type FilterRule,
  type HighlightRule,
  type Profile,
  type TabState,
  type UiState,
} from '../profile/store.js';

interface TabParams {
  id: string;
}

interface PageQuery {
  offset?: string;
  lines?: string;
}

function badRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function parseOffset(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw badRequest('offset должен быть неотрицательным числом');
  return Math.floor(parsed);
}

function parseLines(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PAGE_LINES;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) throw badRequest('lines должен быть положительным числом');
  return Math.min(MAX_PAGE_LINES, Math.floor(parsed));
}

function findTab(profile: Profile, id: string): TabState {
  const tab = profile.tabs.find((item) => item.id === id);
  if (!tab) throw Object.assign(new Error('Вкладка не найдена'), { statusCode: 404 });
  return tab;
}

/**
 * Синтаксические ошибки regex. Возвращаются списком, а НЕ HTTP-ошибкой: панель сохраняет
 * правило на каждый ввод, и 400 на середине паттерна означал бы потерю текста.
 */
function regexIssues(rules: Array<{ id: string; match: string; isRegex: boolean }>): Array<{ id: string; message: string }> {
  const issues: Array<{ id: string; message: string }> = [];
  for (const rule of rules) {
    if (!rule.isRegex || !rule.match) continue;
    try {
      new RegExp(rule.match);
    } catch (error) {
      issues.push({ id: rule.id, message: (error as Error).message });
    }
  }
  return issues;
}

export async function registerRoutes(app: FastifyInstance, pool: LogFilePool): Promise<void> {
  app.get('/api/v1/health', async () => ({
    ok: true,
    name: 'aplog-viewer',
    version: '0.1.0',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/api/v1/profile', async () => loadProfile());

  app.put('/api/v1/profile', async (request) => {
    const body = request.body as Profile | undefined;
    if (!body || typeof body !== 'object') throw badRequest('Тело профиля должно быть объектом');
    return saveProfile(body);
  });

  app.put('/api/v1/rules', async (request) => {
    const body = request.body as { rules?: unknown } | undefined;
    if (!Array.isArray(body?.rules)) throw badRequest('Ожидается { rules: [...] }');
    const profile = await loadProfile();
    profile.rules = body.rules as HighlightRule[];
    const saved = await saveProfile(profile);
    return { rules: saved.rules, issues: regexIssues(saved.rules) };
  });

  app.put('/api/v1/filters', async (request) => {
    const body = request.body as { filters?: unknown } | undefined;
    if (!Array.isArray(body?.filters)) throw badRequest('Ожидается { filters: [...] }');
    const profile = await loadProfile();
    profile.filters = body.filters as FilterRule[];
    const saved = await saveProfile(profile);
    return { filters: saved.filters, issues: regexIssues(saved.filters) };
  });

  app.patch('/api/v1/ui', async (request) => {
    const body = (request.body ?? {}) as Partial<UiState>;
    if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('Тело должно быть объектом');
    const profile = await loadProfile();
    profile.ui = { ...profile.ui, ...body, panels: { ...profile.ui.panels, ...(body.panels ?? {}) } };
    const saved = await saveProfile(profile);
    return saved.ui;
  });

  app.post('/api/v1/tabs', async (request, reply) => {
    const body = (request.body ?? {}) as { path?: string; title?: string; encoding?: string };
    const path = typeof body.path === 'string' ? body.path.trim() : '';
    if (!path) throw badRequest('Укажите путь к файлу лога');
    assertAbsolutePath(path);
    if (!(await pathAvailable(path))) {
      throw Object.assign(new Error(`Файл недоступен: ${path}`), { statusCode: 404 });
    }

    const profile = await loadProfile();
    const existing = profile.tabs.find((tab) => tab.path === path);
    if (existing) {
      existing.tail = true;
      profile.activeTabId = existing.id;
      await saveProfile(profile);
      return reply.code(200).send(existing);
    }

    const encoding = isEncoding(body.encoding) ? body.encoding : null;
    const title = body.title?.trim() || path.split(/[\\/]/).filter(Boolean).pop() || path;
    const tab: TabState = {
      id: newId(),
      path,
      title,
      encoding,
      tail: true,
      wrap: false,
      scrollOffset: 0,
    };
    profile.tabs.push(tab);
    profile.activeTabId = tab.id;
    await saveProfile(profile);
    return reply.code(201).send(tab);
  });

  app.patch('/api/v1/tabs/:id', async (request) => {
    const { id } = request.params as TabParams;
    const body = (request.body ?? {}) as Partial<Pick<TabState, 'title' | 'tail' | 'wrap' | 'scrollOffset'>> & {
      encoding?: string | null;
    };
    const profile = await loadProfile();
    const tab = findTab(profile, id);

    if (typeof body.title === 'string' && body.title.trim()) tab.title = body.title.trim();
    if (typeof body.tail === 'boolean') tab.tail = body.tail;
    if (typeof body.wrap === 'boolean') tab.wrap = body.wrap;
    if (typeof body.scrollOffset === 'number' && Number.isFinite(body.scrollOffset)) {
      tab.scrollOffset = Math.max(0, Math.floor(body.scrollOffset));
    }
    if (body.encoding === null) tab.encoding = null;
    else if (isEncoding(body.encoding)) tab.encoding = body.encoding;

    await saveProfile(profile);
    return tab;
  });

  app.delete('/api/v1/tabs/:id', async (request, reply) => {
    const { id } = request.params as TabParams;
    const profile = await loadProfile();
    const index = profile.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) throw Object.assign(new Error('Вкладка не найдена'), { statusCode: 404 });
    profile.tabs.splice(index, 1);
    if (profile.activeTabId === id) profile.activeTabId = profile.tabs[0]?.id ?? null;
    await saveProfile(profile);
    return reply.code(204).send();
  });

  app.post('/api/v1/tabs/:id/activate', async (request) => {
    const { id } = request.params as TabParams;
    const profile = await loadProfile();
    const tab = findTab(profile, id);
    profile.activeTabId = tab.id;
    await saveProfile(profile);
    return tab;
  });

  app.get('/api/v1/tabs/:id/page', async (request) => {
    const { id } = request.params as TabParams;
    const query = request.query as PageQuery;
    const profile = await loadProfile();
    const tab = findTab(profile, id);
    const file = await pool.get(tab.path, tab.encoding ?? undefined);
    const page = await file.readPage(parseOffset(query.offset), parseLines(query.lines));
    return { tabId: tab.id, path: tab.path, title: tab.title, ...page };
  });

  app.get('/api/v1/tabs/:id/last-page', async (request) => {
    const { id } = request.params as TabParams;
    const query = request.query as PageQuery;
    const profile = await loadProfile();
    const tab = findTab(profile, id);
    const file = await pool.get(tab.path, tab.encoding ?? undefined);
    const page = await file.readLastPage(parseLines(query.lines));
    return { tabId: tab.id, path: tab.path, title: tab.title, ...page };
  });

  app.get('/api/v1/tabs/:id/page-before', async (request) => {
    const { id } = request.params as TabParams;
    const query = request.query as PageQuery;
    const profile = await loadProfile();
    const tab = findTab(profile, id);
    const file = await pool.get(tab.path, tab.encoding ?? undefined);
    const page = await file.pageBefore(parseOffset(query.offset), parseLines(query.lines));
    return { tabId: tab.id, path: tab.path, title: tab.title, ...page };
  });

  app.get('/api/v1/tabs/:id/tail', async (request) => {
    const { id } = request.params as TabParams;
    const query = request.query as PageQuery;
    const profile = await loadProfile();
    const tab = findTab(profile, id);
    const file = await pool.get(tab.path, tab.encoding ?? undefined);
    try {
      const previous = pool.recallIdentity(tab.path);
      const current = await file.identityNow();
      // Сравнение с прошлым опросом, а не только с текущим хендлом: tail закрывает файл
      // после каждого чтения, поэтому «предыдущая» идентичность живёт в пуле.
      const event =
        previous && (previous.dev !== current.dev || previous.ino !== current.ino)
          ? 'rotated'
          : previous && current.size < previous.size
            ? 'truncated'
            : 'ok';
      // Курсор принадлежит прошлому файлу: после ротации или усечения читаем с начала,
      // иначе получим обрывок строки из чужого поколения.
      const requested = parseOffset(query.offset);
      const from = event === 'ok' ? requested : 0;
      const page = await file.readTail(from, MAX_PAGE_LINES);
      return { tabId: tab.id, path: tab.path, title: tab.title, ...page, event };
    } finally {
      // Файл отпускаем сразу: иначе ротация лога на шаре не сможет переименовать файл.
      await pool.release(tab.path);
    }
  });

  app.get('/api/v1/tabs/:id/prev-line', async (request) => {
    const { id } = request.params as TabParams;
    const query = request.query as PageQuery;
    const profile = await loadProfile();
    const tab = findTab(profile, id);
    const file = await pool.get(tab.path, tab.encoding ?? undefined);
    const offset = await file.prevLineStart(parseOffset(query.offset));
    return { offset };
  });
}
