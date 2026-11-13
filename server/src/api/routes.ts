import type { FastifyInstance } from 'fastify';
import { stat } from 'node:fs/promises';
import {
  DEFAULT_PAGE_LINES,
  MAX_PAGE_LINES,
  SEARCH_DEFAULT_MATCHES,
  SEARCH_MAX_BYTES,
  SEARCH_MAX_MATCHES,
} from '../config.js';
import { detectEncoding, isEncoding, type Encoding } from '../files/encoding.js';
import { LineIndexService, type LineIndexInput } from '../files/lineIndex.js';
import type { LogFile, LogFilePool } from '../files/reader.js';
import { runSearch } from '../search/search.js';
import type { SearchDirection } from '../search/protocol.js';
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

interface LineQuery {
  line?: string;
}

interface SearchBody {
  query?: unknown;
  isRegex?: unknown;
  caseSensitive?: unknown;
  direction?: unknown;
  fromOffset?: unknown;
  limit?: unknown;
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

function parseLineNumber(value: string | undefined): number {
  if (value === undefined || value === '') throw badRequest('Укажите номер строки');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest('line должен быть положительным целым числом');
  }
  return parsed;
}

/** Всё, что индексу нужно знать о файле на момент запроса. */
function indexInput(file: LogFile): LineIndexInput {
  return { path: file.path, id: file.id, encoding: file.encoding, size: file.size };
}

/**
 * Индексные маршруты не берут файл из пула: иначе после каждого tail-append они
 * переоткрывали бы хэндл и держали его до простоя, мешая ночной ротации через rename.
 * stat и автоопределение кодировки открывают и сразу закрывают собственные хэндлы.
 */
const detectedEncodings = new Map<string, { encoding: Encoding; size: number }>();

async function indexInputForTab(tab: TabState): Promise<LineIndexInput> {
  const stats = await stat(tab.path, { bigint: true });
  const id = `${stats.dev.toString()}:${stats.ino.toString()}`;
  const size = Number(stats.size);
  let encoding = tab.encoding ?? undefined;
  if (!encoding) {
    const cached = detectedEncodings.get(id);
    // Усечение могло сменить содержимое и кодировку: тогда автоопределяем заново.
    if (cached && size >= cached.size) {
      encoding = cached.encoding;
    } else {
      encoding = await detectEncoding(tab.path);
      detectedEncodings.set(id, { encoding, size });
    }
  }
  return { path: tab.path, id, encoding, size };
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

export async function registerRoutes(
  app: FastifyInstance,
  pool: LogFilePool,
  lineIndex = new LineIndexService(),
): Promise<void> {
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
    profile.ui = {
      ...profile.ui,
      ...body,
      panels: { ...profile.ui.panels, ...(body.panels ?? {}) },
      search: { ...profile.ui.search, ...(body.search ?? {}) },
    };
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
    // Номер первой строки знает только индекс; без покрытия — null, и UI покажет `·`.
    const firstLine = page.lines[0] ? await lineIndex.lineNumberAt(indexInput(file), page.lines[0].offset) : null;
    return { tabId: tab.id, path: tab.path, title: tab.title, ...page, firstLine };
  });

  app.get('/api/v1/tabs/:id/last-page', async (request) => {
    const { id } = request.params as TabParams;
    const query = request.query as PageQuery;
    const profile = await loadProfile();
    const tab = findTab(profile, id);
    const file = await pool.get(tab.path, tab.encoding ?? undefined);
    const page = await file.readLastPage(parseLines(query.lines));
    const firstLine = page.lines[0] ? await lineIndex.lineNumberAt(indexInput(file), page.lines[0].offset) : null;
    return { tabId: tab.id, path: tab.path, title: tab.title, ...page, firstLine };
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

  app.post('/api/v1/tabs/:id/line-index', async (request) => {
    const { id } = request.params as TabParams;
    const profile = await loadProfile();
    const tab = findTab(profile, id);
    // stat здесь же: индекс должен видеть актуальный размер после дописывания.
    return { tabId: tab.id, path: tab.path, ...(await lineIndex.start(await indexInputForTab(tab))) };
  });

  app.get('/api/v1/tabs/:id/line-index', async (request) => {
    const { id } = request.params as TabParams;
    const profile = await loadProfile();
    const tab = findTab(profile, id);
    return { tabId: tab.id, path: tab.path, ...(await lineIndex.status(await indexInputForTab(tab))) };
  });

  app.get('/api/v1/tabs/:id/line-number', async (request) => {
    const { id } = request.params as TabParams;
    const query = request.query as PageQuery;
    const profile = await loadProfile();
    const tab = findTab(profile, id);
    const offset = parseOffset(query.offset);
    const input = await indexInputForTab(tab);
    const status = await lineIndex.status(input);
    const line = await lineIndex.lineNumberAt(input, offset);
    return { tabId: tab.id, path: tab.path, offset, line, ...status };
  });

  app.get('/api/v1/tabs/:id/line-offset', async (request) => {
    const { id } = request.params as TabParams;
    const query = request.query as LineQuery;
    const profile = await loadProfile();
    const tab = findTab(profile, id);
    const line = parseLineNumber(query.line);
    const input = await indexInputForTab(tab);
    const status = await lineIndex.status(input);
    const offset = await lineIndex.offsetForLine(input, line);
    return { tabId: tab.id, path: tab.path, line, offset, ...status };
  });

  app.post('/api/v1/tabs/:id/search', async (request) => {
    const { id } = request.params as TabParams;
    const body = (request.body ?? {}) as SearchBody;

    const query = typeof body.query === 'string' ? body.query : '';
    if (!query) throw badRequest('Введите строку поиска');
    if (query.length > 500) throw badRequest('Строка поиска длиннее 500 символов');

    const isRegex = Boolean(body.isRegex);
    const caseSensitive = body.caseSensitive !== false;
    if (isRegex) {
      try {
        new RegExp(query);
      } catch (error) {
        throw badRequest(`Ошибка в выражении: ${(error as Error).message}`);
      }
    }

    const fromRaw = Number(body.fromOffset ?? 0);
    if (!Number.isFinite(fromRaw) || fromRaw < 0) {
      throw badRequest('fromOffset должен быть неотрицательным числом');
    }
    const limitRaw = Number(body.limit ?? SEARCH_DEFAULT_MATCHES);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(SEARCH_MAX_MATCHES, Math.max(1, Math.floor(limitRaw)))
      : SEARCH_DEFAULT_MATCHES;

    const profile = await loadProfile();
    const tab = findTab(profile, id);
    const file = await pool.get(tab.path, tab.encoding ?? undefined);
    // Принудительный stat: поиск должен видеть актуальный размер и кодировку,
    // а не закешированные с прошлой страницы.
    const event = await file.refresh(true);

    const result = await runSearch({
      path: tab.path,
      encoding: file.encoding,
      size: file.size,
      query,
      isRegex,
      caseSensitive,
      direction: (body.direction === 'backward' ? 'backward' : 'forward') as SearchDirection,
      fromOffset: Math.floor(fromRaw),
      limit,
      maxBytes: SEARCH_MAX_BYTES,
    });
    if (result.error) throw Object.assign(new Error(result.error), { statusCode: 500 });

    return {
      tabId: tab.id,
      path: tab.path,
      title: tab.title,
      encoding: file.encoding,
      event,
      ...result,
    };
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
