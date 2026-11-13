/**
 * Точные номера строк через API: разреженный индекс, firstLine у страниц, переход
 * к строке, достройка после append, сброс после усечения, кодировки и кэш на диске.
 * Запуск: node scripts/check-lines.mjs [baseUrl]
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import iconv from 'iconv-lite';
import { LineIndexService } from '../server/dist/files/lineIndex.js';

const base = process.argv[2] ?? 'http://127.0.0.1:7801';
const dir = join(process.cwd(), '.aplog', 'test');
const suffix = `${process.pid}-${Date.now()}`;
const utf8File = join(dir, `lines-${suffix}.log`);
const cpFile = join(dir, `lines-cp1251-${suffix}.log`);
const utf16File = join(dir, `lines-utf16-${suffix}.log`);
const openEndFile = join(dir, `lines-open-end-${suffix}.log`);
const emptyFile = join(dir, `lines-empty-${suffix}.log`);
const files = [utf8File, cpFile, utf16File, openEndFile, emptyFile];

const cacheDirs = [
  join(process.cwd(), '.aplog', 'cache'),
  join(process.cwd(), '.aplog', 'test-profile', 'cache'),
];
if (process.env.APLOG_PROFILE_DIR) {
  cacheDirs.push(join(process.env.APLOG_PROFILE_DIR, 'cache'));
}
const uniqueCacheDirs = [...new Set(cacheDirs)];

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

async function get(path) {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
  return response.json();
}

async function send(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function addTab(path) {
  const result = await send('POST', '/api/v1/tabs', { path: resolve(path) });
  if (result.status !== 201 && result.status !== 200) {
    throw new Error(`Не удалось открыть вкладку: ${JSON.stringify(result)}`);
  }
  return result.json;
}

async function startIndex(tabId) {
  return (await send('POST', `/api/v1/tabs/${tabId}/line-index`)).json;
}

async function waitComplete(tabId, expectedLines, timeoutMs = 20000) {
  await startIndex(tabId);
  const deadline = Date.now() + timeoutMs;
  let status = await get(`/api/v1/tabs/${tabId}/line-index`);
  while (!status.complete && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    status = await get(`/api/v1/tabs/${tabId}/line-index`);
  }
  if (expectedLines !== undefined) {
    check(
      `индекс достроен: ${expectedLines} строк`,
      status.complete && status.knownLines === expectedLines,
      status,
    );
  }
  return status;
}

/** Байтовые смещения начал строк; offsets[i] — строка i + 1. */
function lineOffsets(lines, encode) {
  const offsets = [0];
  let position = 0;
  for (const line of lines) {
    position += encode(`${line}\n`).length;
    offsets.push(position);
  }
  return offsets;
}

const utf8 = (value) => Buffer.from(value, 'utf8');
const cp1251 = (value) => iconv.encode(value, 'win1251');
const utf16le = (value) => Buffer.from(value, 'utf16le');

async function fixture(path, lines, encode, options = {}) {
  const body = Buffer.concat(lines.map((line) => encode(`${line}\n`)));
  const bytes = options.bom ? Buffer.concat([options.bom, body]) : body;
  await writeFile(path, options.trailingNewline === false ? bytes.subarray(0, bytes.length - encode('\n').length) : bytes);
  return bytes;
}

function expectedCacheName(id, encoding) {
  const key = createHash('sha1').update(`${id}|${encoding}|1024`).digest('hex');
  return `lines-${key}.json`;
}

async function identity(path) {
  const stats = await stat(path, { bigint: true });
  return { id: `${stats.dev}:${stats.ino}`, size: Number(stats.size) };
}

async function findCacheFile(path, encoding) {
  const { id } = await identity(path);
  const name = expectedCacheName(id, encoding);
  for (const cacheDir of uniqueCacheDirs) {
    const candidate = join(cacheDir, name);
    try {
      await readFile(candidate, 'utf8');
      return { cacheDir, file: candidate, name };
    } catch {
      // каталог/файл отсутствует — смотрим следующий
    }
  }
  return { cacheDir: null, file: null, name };
}

async function directStatus(path, encoding) {
  const { id, size } = await identity(path);
  const { cacheDir } = await findCacheFile(path, encoding);
  if (!cacheDir) return null;
  const service = new LineIndexService(cacheDir);
  return service.status({ path: resolve(path), id, encoding, size });
}

async function cleanupCaches(paths) {
  const wanted = new Set(paths.map((path) => resolve(path)));
  for (const cacheDir of uniqueCacheDirs) {
    let entries = [];
    try {
      entries = await readdir(cacheDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith('lines-') || !entry.endsWith('.json')) continue;
      const file = join(cacheDir, entry);
      try {
        const cache = JSON.parse(await readFile(file, 'utf8'));
        if (wanted.has(resolve(cache.path))) await unlink(file);
      } catch {
        // битый кэш не наш — не трогаем
      }
    }
  }
}

const original = await get('/api/v1/profile');
const tabs = [];

try {
  // --- UTF-8: 5000 строк, ровные смещения ---
  const lines = Array.from({ length: 5000 }, (_, index) => `2026-11-13 10:00:00 INFO line ${index + 1}`);
  await fixture(utf8File, lines, utf8);
  const offsets = lineOffsets(lines, utf8);
  const size = (await stat(utf8File)).size;

  const tab = await addTab(utf8File);
  tabs.push(tab.id);

  const started = await startIndex(tab.id);
  check('POST /line-index отвечает 200 и шагом 1024', started?.step === 1024, started);

  const ready = await waitComplete(tab.id, 5000);
  check('полный индекс: 100% и ready', ready.complete && ready.state === 'ready', ready);
  check('размер индекса совпадает с файлом', ready.scannedTo === size, { ready: ready.scannedTo, size });

  const firstPage = await get(`/api/v1/tabs/${tab.id}/page?offset=0&lines=10`);
  check('первая страница: firstLine = 1', firstPage.firstLine === 1, firstPage.firstLine);

  const lastPage = await get(`/api/v1/tabs/${tab.id}/last-page?lines=100`);
  check('последняя страница: firstLine = 4901', lastPage.firstLine === 4901, lastPage.firstLine);

  const middlePage = await get(`/api/v1/tabs/${tab.id}/page?offset=${offsets[2500]}&lines=10`);
  check('страница из середины: firstLine = 2501', middlePage.firstLine === 2501, middlePage.firstLine);

  let target = await get(`/api/v1/tabs/${tab.id}/line-offset?line=1500`);
  check('line-offset 1500: точное смещение', target.offset === offsets[1499], {
    got: target.offset,
    want: offsets[1499],
  });

  let number = await get(`/api/v1/tabs/${tab.id}/line-number?offset=${offsets[1499]}`);
  check('line-number: обратно 1500', number.line === 1500, number.line);

  target = await get(`/api/v1/tabs/${tab.id}/line-offset?line=1025`);
  check('засечка 1025: смещение точное', target.offset === offsets[1024], {
    got: target.offset,
    want: offsets[1024],
  });

  number = await get(`/api/v1/tabs/${tab.id}/line-number?offset=${offsets[1024]}`);
  check('засечка 1025: номер точный', number.line === 1025, number.line);

  target = await get(`/api/v1/tabs/${tab.id}/line-offset?line=1024`);
  check('строка до засечки: 1024', target.offset === offsets[1023], target.offset);

  target = await get(`/api/v1/tabs/${tab.id}/line-offset?line=6000`);
  check('строка за концом: offset = null', target.offset === null && target.complete, target);

  const invalid = await send('GET', `/api/v1/tabs/${tab.id}/line-offset?line=0`);
  check('line=0 отклоняется с 400', invalid.status === 400, invalid);

  const cache = await findCacheFile(utf8File, 'utf-8');
  check('кэш индекса записан на диск', Boolean(cache.file), cache);

  const cached = await directStatus(utf8File, 'utf-8');
  check(
    'новый экземпляр сервиса читает индекс из кэша',
    cached?.fromCache === true && cached?.knownLines === 5000 && cached?.complete === true,
    cached,
  );

  // --- Дописывание: индекс продолжается, номера новых строк точные ---
  const appendedLines = [
    '2026-11-13 10:00:01 INFO appended 5001',
    '2026-11-13 10:00:02 INFO appended 5002',
    '2026-11-13 10:00:03 INFO appended 5003',
  ];
  const extra = appendedLines.map((line) => utf8(`${line}\n`));
  const extraBytes = Buffer.concat(extra);
  const startOffset = offsets[5000];
  await writeFile(utf8File, extraBytes, { flag: 'a' });
  const extendedOffsets = [...offsets, startOffset + extra[0].length, startOffset + extra[0].length + extra[1].length];

  const extended = await waitComplete(tab.id, 5003);
  check('после append индекс вырос без пересборки', extended.complete && extended.scannedTo === size + extraBytes.length, extended);

  target = await get(`/api/v1/tabs/${tab.id}/line-offset?line=5003`);
  check('новая строка 5003 имеет точное смещение', target.offset === extendedOffsets[5002], {
    got: target.offset,
    want: extendedOffsets[5002],
  });

  const lastAfterAppend = await get(`/api/v1/tabs/${tab.id}/last-page?lines=100`);
  check('last-page после append: firstLine = 4904', lastAfterAppend.firstLine === 4904, lastAfterAppend.firstLine);

  // --- Усечение: старый индекс не должен пережить новое содержимое ---
  const shortLines = lines.slice(0, 100);
  await fixture(utf8File, shortLines, utf8);
  const truncated = await waitComplete(tab.id, 100);
  check('после усечения индекс пересчитан с нуля', truncated.complete && truncated.knownLines === 100, truncated);

  target = await get(`/api/v1/tabs/${tab.id}/line-offset?line=101`);
  check('после усечения строки 101 нет', target.offset === null && target.complete, target);

  number = await get(`/api/v1/tabs/${tab.id}/line-number?offset=0`);
  check('после усечения первая строка = 1', number.line === 1, number.line);

  // --- cp1251: кириллица не влияет на байтовые засечки ---
  const cpLines = Array.from({ length: 1500 }, (_, index) => `2026-11-13 10:00:00 ИНФО строка ${index + 1}`);
  await fixture(cpFile, cpLines, cp1251);
  const cpOffsets = lineOffsets(cpLines, cp1251);
  const cpTab = await addTab(cpFile);
  tabs.push(cpTab.id);
  const cpReady = await waitComplete(cpTab.id, 1500);
  check('cp1251: кодировка определена', cpReady.encoding === 'cp1251', cpReady.encoding);
  target = await get(`/api/v1/tabs/${cpTab.id}/line-offset?line=1200`);
  check('cp1251: смещение строки 1200 точное', target.offset === cpOffsets[1199], {
    got: target.offset,
    want: cpOffsets[1199],
  });
  number = await get(`/api/v1/tabs/${cpTab.id}/line-number?offset=${cpOffsets[1199]}`);
  check('cp1251: номер строки обратно 1200', number.line === 1200, number.line);
  const cpLast = await get(`/api/v1/tabs/${cpTab.id}/last-page?lines=100`);
  check('cp1251: last-page firstLine = 1401', cpLast.firstLine === 1401, cpLast.firstLine);

  // --- UTF-16LE с BOM: перевод строки — двухбайтовая пара ---
  const utf16Lines = Array.from({ length: 1200 }, (_, index) => `2026-11-13 10:00:00 UTF16 line ${index + 1}`);
  await fixture(utf16File, utf16Lines, utf16le, { bom: Buffer.from([0xff, 0xfe]) });
  const utf16Offsets = lineOffsets(utf16Lines, utf16le).map((offset) => offset + 2);
  const utf16Tab = await addTab(utf16File);
  tabs.push(utf16Tab.id);
  const utf16Ready = await waitComplete(utf16Tab.id, 1200);
  check('utf-16le: кодировка определена', utf16Ready.encoding === 'utf-16le', utf16Ready.encoding);
  target = await get(`/api/v1/tabs/${utf16Tab.id}/line-offset?line=800`);
  check('utf-16le: смещение строки 800 точное', target.offset === utf16Offsets[799], {
    got: target.offset,
    want: utf16Offsets[799],
  });
  number = await get(`/api/v1/tabs/${utf16Tab.id}/line-number?offset=${utf16Offsets[799]}`);
  check('utf-16le: номер строки обратно 800', number.line === 800, number.line);

  // --- Последняя строка без перевода: лишней строки быть не должно ---
  const openLines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
  await fixture(openEndFile, openLines, utf8, { trailingNewline: false });
  const openTab = await addTab(openEndFile);
  tabs.push(openTab.id);
  const openReady = await waitComplete(openTab.id, 10);
  check('файл без перевода в конце: ровно 10 строк', openReady.knownLines === 10, openReady.knownLines);
  target = await get(`/api/v1/tabs/${openTab.id}/line-offset?line=10`);
  const openSize = (await stat(openEndFile)).size;
  check('последняя строка без перевода находится', target.offset !== null && target.offset < openSize, target);
  target = await get(`/api/v1/tabs/${openTab.id}/line-offset?line=11`);
  check('одиннадцатой строки нет', target.offset === null, target);

  // --- Пустой файл ---
  await writeFile(emptyFile, '');
  const emptyTab = await addTab(emptyFile);
  tabs.push(emptyTab.id);
  const emptyReady = await waitComplete(emptyTab.id, 0);
  check('пустой файл: complete и 0 строк', emptyReady.complete && emptyReady.knownLines === 0, emptyReady);
  target = await get(`/api/v1/tabs/${emptyTab.id}/line-offset?line=1`);
  check('пустой файл: строки 1 нет', target.offset === null, target);
} finally {
  for (const id of tabs) {
    await fetch(`${base}/api/v1/tabs/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }
  if (original.activeTabId) {
    await send('POST', `/api/v1/tabs/${original.activeTabId}/activate`, {}).catch(() => undefined);
  }
  for (const path of files) {
    await rm(path, { force: true });
  }
  await cleanupCaches(files).catch(() => undefined);
}

process.exitCode = failed === 0 ? 0 : 1;
