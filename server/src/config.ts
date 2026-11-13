import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

/** Каталог репозитория: server/src -> server -> корень, server/dist -> server -> корень. */
export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const HOST = process.env.APLOG_HOST ?? '127.0.0.1';
export const PORT = Number(process.env.APLOG_PORT ?? 7801);

/** Portable-профиль рядом с приложением; путь можно переопределить env-переменной. */
export const PROFILE_DIR = resolve(process.env.APLOG_PROFILE_DIR ?? join(ROOT, '.aplog'));
export const PROFILE_FILE = join(PROFILE_DIR, 'profile.json');
export const CACHE_DIR = join(PROFILE_DIR, 'cache');

export const WEB_DIST = join(ROOT, 'web', 'dist');

/** Сколько байт читаем за один заход и сколько максимум на одну страницу строк. */
export const READ_CHUNK_BYTES = 64 * 1024;
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;

/** Пределы страницы и тайминги опроса хвоста. */
export const DEFAULT_PAGE_LINES = 300;
export const MAX_PAGE_LINES = 2000;
export const TAIL_INTERVAL_MS = 1500;

/** Открытые файлы держим не дольше этого простоя: писатель должен мочь ротировать лог. */
export const HANDLE_IDLE_MS = 60 * 1000;

/**
 * Поиск: за один запрос просматриваем не больше 16 МБ и отдаём до 200 совпадений.
 * Курсор в ответе позволяет продолжить с того места, поэтому лимит не теряет данные.
 */
export const SEARCH_MAX_BYTES = 16 * 1024 * 1024;
export const SEARCH_DEFAULT_MATCHES = 200;
export const SEARCH_MAX_MATCHES = 500;
/** Бюджет воркера: дольше держать поток с потенциально зависшим regex нельзя. */
export const SEARCH_TIMEOUT_MS = 5000;

/**
 * Разреженный индекс строк: засечка каждые 1024 строки. Номер ищется чтением не больше
 * одного блока от засечки. Строим окнами по 1 МБ и сохраняем прогресс каждые 32 МБ,
 * чтобы перезапуск на гигабайтном файле не начинался с нуля.
 */
export const LINE_INDEX_STEP = 1024;
export const LINE_INDEX_CHUNK_BYTES = 1024 * 1024;
export const LINE_INDEX_SAVE_BYTES = 32 * 1024 * 1024;
