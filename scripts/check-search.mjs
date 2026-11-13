/**
 * Поиск по файлу через API: направления, курсор, регистр, regex, кодировки и таймаут.
 * Вкладки и фикстуры удаляются в finally.
 * Запуск: node scripts/check-search.mjs [baseUrl]
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import iconv from 'iconv-lite';

const base = process.argv[2] ?? 'http://127.0.0.1:7801';
const dir = join(process.cwd(), '.aplog', 'test');
const utf8File = join(dir, 'search.log');
const cpFile = join(dir, 'search-cp1251.log');
const utf16File = join(dir, 'search-utf16.log');
const redosFile = join(dir, 'search-redos.log');

await mkdir(dir, { recursive: true });

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    console.log(`FAIL ${name}: ${JSON.stringify(detail)}`);
    failed += 1;
  }
}

async function send(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function search(id, body) {
  return send('POST', `/api/v1/tabs/${id}/search`, body);
}

async function addTab(path) {
  const result = await send('POST', '/api/v1/tabs', { path: resolve(path) });
  if (result.status !== 201 && result.status !== 200) {
    throw new Error(`Не удалось открыть вкладку: ${JSON.stringify(result)}`);
  }
  return result.json;
}

const original = await (await fetch(`${base}/api/v1/profile`)).json();
const tabs = [];

try {
  // --- UTF-8: 1000 строк, ERROR в 10, 500 и 999 ---
  const lines = Array.from({ length: 1000 }, (_, index) => {
    const number = index + 1;
    const level = number === 10 || number === 500 || number === 999 ? 'ERROR' : 'INFO';
    return `2026-11-13 10:00:00 ${level} line ${number}`;
  });
  await writeFile(utf8File, `${lines.join('\n')}\n`, 'utf8');
  const fileSize = (await stat(utf8File)).size;

  const tab = await addTab(utf8File);
  tabs.push(tab.id);

  let result = await search(tab.id, {
    query: 'ERROR',
    isRegex: false,
    caseSensitive: true,
    direction: 'forward',
    fromOffset: 0,
    limit: 2,
  });
  check('forward: ответ 200', result.status === 200, result.status);
  check('forward: найдено 2 совпадения', result.json?.matches?.length === 2, result.json?.matches);
  check(
    'forward: строки по возрастанию и с ERROR',
    result.json?.matches?.[0]?.text?.includes('line 10') &&
      result.json?.matches?.[1]?.text?.includes('line 500'),
    result.json?.matches,
  );
  check(
    'forward: курсор — конец последнего совпадения',
    result.json?.cursor === result.json?.matches?.[1]?.endOffset,
    result.json?.cursor,
  );
  check('forward: eof ещё не достигнут', result.json?.eof === false, result.json?.eof);

  const afterFirst = result.json;
  result = await search(tab.id, {
    query: 'ERROR',
    isRegex: false,
    caseSensitive: true,
    direction: 'forward',
    fromOffset: afterFirst.cursor,
    limit: 2,
  });
  check(
    'forward: продолжение с курсора находит line 999',
    result.json?.matches?.length === 1 && result.json.matches[0].text.includes('line 999'),
    result.json?.matches,
  );

  result = await search(tab.id, {
    query: 'ERROR',
    isRegex: false,
    caseSensitive: true,
    direction: 'forward',
    fromOffset: result.json.cursor,
    limit: 2,
  });
  check('forward: после последнего совпадения eof', result.json?.matches?.length === 0 && result.json?.eof === true, result.json);

  // --- Назад: от конца файла приходят ближайшие совпадения ---
  result = await search(tab.id, {
    query: 'ERROR',
    isRegex: false,
    caseSensitive: true,
    direction: 'backward',
    fromOffset: fileSize,
    limit: 2,
  });
  check(
    'backward: ближайшие две строки — 500 и 999',
    result.json?.matches?.length === 2 &&
      result.json.matches[0].text.includes('line 500') &&
      result.json.matches[1].text.includes('line 999'),
    result.json?.matches,
  );
  const nearest = result.json;
  result = await search(tab.id, {
    query: 'ERROR',
    isRegex: false,
    caseSensitive: true,
    direction: 'backward',
    fromOffset: nearest.cursor,
    limit: 2,
  });
  check(
    'backward: продолжение доходит до line 10 и eof',
    result.json?.matches?.length === 1 &&
      result.json.matches[0].text.includes('line 10') &&
      result.json.eof === true,
    result.json,
  );

  // --- Регистр ---
  result = await search(tab.id, {
    query: 'error',
    isRegex: false,
    caseSensitive: true,
    direction: 'forward',
    fromOffset: 0,
    limit: 10,
  });
  check('регистр учитывается', result.json?.matches?.length === 0 && result.json?.eof === true, result.json);

  result = await search(tab.id, {
    query: 'error',
    isRegex: false,
    caseSensitive: false,
    direction: 'forward',
    fromOffset: 0,
    limit: 10,
  });
  check('регистр игнорируется по флагу', result.json?.matches?.length === 3, result.json?.matches);

  // --- Regex ---
  result = await search(tab.id, {
    query: 'ERROR line (10|500)',
    isRegex: true,
    caseSensitive: true,
    direction: 'forward',
    fromOffset: 0,
    limit: 10,
  });
  check('regex находит две строки', result.json?.matches?.length === 2, result.json?.matches);

  result = await search(tab.id, {
    query: '(',
    isRegex: true,
    caseSensitive: true,
    direction: 'forward',
    fromOffset: 0,
  });
  check('битый regex — 400 с текстом', result.status === 400 && typeof result.json?.error === 'string', result);

  result = await search(tab.id, {
    query: '',
    isRegex: false,
    caseSensitive: true,
    direction: 'forward',
    fromOffset: 0,
  });
  check('пустой запрос — 400', result.status === 400, result);

  result = await search(tab.id, {
    query: 'ERROR',
    isRegex: false,
    caseSensitive: true,
    direction: 'forward',
    fromOffset: -1,
  });
  check('отрицательный fromOffset — 400', result.status === 400, result);

  // --- cp1251: автодетект ---
  const cpLines = Array.from({ length: 40 }, (_, index) =>
    index === 7 ? 'Ошибка в строке 8' : `Строка ${index + 1} без проблемы`,
  );
  await writeFile(cpFile, iconv.encode(`${cpLines.join('\r\n')}\r\n`, 'win1251'));
  const cpTab = await addTab(cpFile);
  tabs.push(cpTab.id);
  result = await search(cpTab.id, {
    query: 'Ошибка',
    isRegex: false,
    caseSensitive: true,
    direction: 'forward',
    fromOffset: 0,
  });
  check('cp1251: кодировка определена', result.json?.encoding === 'cp1251', result.json?.encoding);
  check('cp1251: русский запрос найден', result.json?.matches?.length === 1, result.json?.matches);

  // --- UTF-16LE с ручным override ---
  const utf16Text = 'первая строка\r\nСбой в третьей строке\r\nпоследняя строка\r\n';
  await writeFile(utf16File, iconv.encode(utf16Text, 'utf16-le'));
  const utf16Tab = await addTab(utf16File);
  tabs.push(utf16Tab.id);
  await send('PATCH', `/api/v1/tabs/${utf16Tab.id}`, { encoding: 'utf-16le' });
  result = await search(utf16Tab.id, {
    query: 'Сбой',
    isRegex: false,
    caseSensitive: true,
    direction: 'forward',
    fromOffset: 0,
  });
  check('utf-16le: запрос найден', result.json?.matches?.length === 1, result.json?.matches);

  // --- Таймаут патологического regex ---
  const redosLines = [`ERROR ${'a'.repeat(36)}b`, ...Array.from({ length: 50 }, (_, i) => `INFO ${i}`)];
  await writeFile(redosFile, `${redosLines.join('\n')}\n`, 'utf8');
  const redosTab = await addTab(redosFile);
  tabs.push(redosTab.id);
  const started = Date.now();
  const pending = search(redosTab.id, {
    query: '(a+)+$',
    isRegex: true,
    caseSensitive: true,
    direction: 'forward',
    fromOffset: 0,
  });

  // Пока воркер висит на бэктрекинге, Fastify обязан отвечать: иначе защита
  // от зависания бесполезна — встанет весь дашборд.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  const healthStarted = Date.now();
  const health = await fetch(`${base}/api/v1/health`);
  const healthMs = Date.now() - healthStarted;
  check('поиск не блокирует API', health.ok && healthMs < 1000, healthMs);

  result = await pending;
  const elapsed = Date.now() - started;
  check('таймаут: ответ 200, а не 500', result.status === 200, result.status);
  check('таймаут: timedOut=true', result.json?.timedOut === true, result.json);
  check('таймаут: уложились в бюджет', elapsed < 9000, elapsed);
} finally {
  for (const id of tabs) {
    await fetch(`${base}/api/v1/tabs/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }
  if (original.activeTabId) {
    await send('POST', `/api/v1/tabs/${original.activeTabId}/activate`, {}).catch(() => undefined);
  }
  await Promise.all(
    [utf8File, cpFile, utf16File, redosFile].map((path) => rm(path, { force: true })),
  );
}

process.exitCode = failed === 0 ? 0 : 1;
