/**
 * Номера строк в браузере: `·` без индекса, точные номера с фильтром, Ctrl+G,
 * непрерывность при догрузке вверх и дописывании файла.
 * Запуск: node scripts/check-lines-ui.mjs [baseUrl]
 */
import { appendFile, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:7801';
const browserPath =
  process.env.APLOG_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const dir = join(process.cwd(), '.aplog', 'test');
const file = join(dir, `lines-ui-${process.pid}-${Date.now()}.log`);
const TOTAL = 3000;

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
  return response.json().catch(() => null);
}

async function rows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.row')].map((row) => ({
      number: row.querySelector('.line-no')?.textContent?.trim() ?? '',
      text: row.querySelector('.text')?.textContent ?? '',
    })),
  );
}

/** Каждый номер в линейке должен совпадать с номером из текста строки. */
function numberedCorrectly(list) {
  return list.length > 0 && list.every((row) => {
    const parsed = row.text.match(/line (\d+)/);
    return parsed ? row.number === parsed[1] : false;
  });
}

const original = await get('/api/v1/profile');
const originalFilters = original.filters;
let browser = null;
let tab = null;
const cacheDirs = [
  join(process.cwd(), '.aplog', 'cache'),
  join(process.cwd(), '.aplog', 'test-profile', 'cache'),
];

try {
  const lines = Array.from({ length: TOTAL }, (_, index) => {
    const number = index + 1;
    const level = number % 100 === 0 ? 'ERROR' : 'INFO';
    return `2026-11-13 10:00:00 ${level} line ${number}`;
  });
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');

  await send('PUT', '/api/v1/filters', {
    filters: [
      {
        id: 'lines-ui-filter',
        enabled: true,
        mode: 'include',
        match: 'ERROR',
        isRegex: false,
        caseSensitive: true,
        tabId: null,
      },
    ],
  });
  tab = await send('POST', '/api/v1/tabs', { path: resolve(file) });

  browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  page.on('pageerror', (error) => console.log('PAGEERROR', error.message));

  // Пока индекс недоступен, линейка обязана показывать `·`, а не выдуманные номера.
  let blockIndex = true;
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (blockIndex && (url.includes('/line-index') || url.includes('/line-number'))) {
      void request.abort();
    } else {
      void request.continue();
    }
  });

  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('.filter-bar', { timeout: 20000 });
  await page.waitForSelector('.row', { timeout: 20000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.line-no')].every((node) => node.textContent?.trim() === '·'),
    { timeout: 5000 },
  );
  const dots = await rows(page);
  check('без индекса линейка показывает `·`', dots.every((row) => row.number === '·'), dots.slice(0, 3));

  blockIndex = false;
  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('.filter-bar', { timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelector('.status')?.textContent?.includes('индекс 100%') ?? false,
    { timeout: 30000 },
  );
  await page.waitForFunction(
    () => {
      const list = [...document.querySelectorAll('.row')];
      return (
        list.length > 0 &&
        list.every((row) => row.textContent?.includes('ERROR')) &&
        [...document.querySelectorAll('.line-no')].every((node) => node.textContent?.trim() !== '·')
      );
    },
    { timeout: 30000 },
  );

  const filtered = await rows(page);
  check('под фильтром номера строк точные', numberedCorrectly(filtered), filtered.slice(0, 5));
  check(
    'под фильтром показаны только ERROR',
    filtered.length > 0 && filtered.every((row) => row.text.includes('ERROR')),
    filtered.slice(0, 3),
  );
  const filteredStatus = (await page.$eval('.status', (element) => element.textContent ?? '')).replace(/\s+/g, ' ');
  check(
    'в статусе есть число строк файла',
    filteredStatus.includes('строк в файле: 3 000'),
    filteredStatus,
  );

  // Снимаем фильтр: проверяем нумерацию обычного просмотра и кэш после reload.
  await send('PUT', '/api/v1/filters', { filters: [] });
  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('.row', { timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelector('.status')?.textContent?.includes('индекс 100%') ?? false,
    { timeout: 30000 },
  );
  await page.waitForFunction(
    () => document.querySelector('.row .line-no')?.textContent?.trim() !== '·',
    { timeout: 15000 },
  );

  const tailRows = await rows(page);
  check('после reload из кэша нумерация с последней страницы', numberedCorrectly(tailRows), tailRows.slice(0, 3));
  check(
    'последняя строка последней страницы — 3000',
    tailRows[tailRows.length - 1]?.number === '3000' &&
      tailRows[tailRows.length - 1]?.text.includes('line 3000'),
    tailRows[tailRows.length - 1],
  );

  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === 'в начало',
    );
    button?.click();
  });
  await page.waitForFunction(
    () => document.querySelector('.row')?.textContent?.includes('line 1') ?? false,
    { timeout: 15000 },
  );
  check(
    'в начале файла первая строка = 1',
    (await page.$eval('.row .line-no', (element) => element.textContent?.trim())) === '1',
    await page.$eval('.row', (element) => element.textContent),
  );

  // Ctrl+G: поле получает фокус, Enter переходит к строке.
  await page.keyboard.down('Control');
  await page.keyboard.press('g');
  await page.keyboard.up('Control');
  check(
    'Ctrl+G передаёт фокус полю «строка»',
    await page.evaluate(() => document.activeElement?.classList.contains('line-input') ?? false),
  );
  await page.keyboard.type('1500');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      document.querySelector('.row')?.textContent?.includes('line 1500') &&
      document.querySelector('.row .line-no')?.textContent?.trim() === '1500',
    { timeout: 15000 },
  );
  check('Ctrl+G переходит к строке 1500', true);
  check(
    'перейдённая строка подсвечена',
    await page.evaluate(() => document.querySelector('.row')?.classList.contains('row-target') ?? false),
  );

  // Догрузка вверх не должна сбивать нумерацию.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === 'выше',
    );
    button?.click();
  });
  await page.waitForFunction(
    () => (document.querySelector('.status')?.textContent ?? '').includes('строк в буфере: 800'),
    { timeout: 15000 },
  );
  await page.evaluate(() => {
    const element = document.querySelector('.log');
    if (element) element.scrollTop = 2000;
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.row')].some((row) => row.textContent?.includes('line 1200')),
    { timeout: 15000 },
  );
  const prepended = await rows(page);
  check('после «выше» номера продолжаются', numberedCorrectly(prepended), prepended.slice(0, 3));
  check(
    'строка 1200 из догруженного диапазона пронумерована верно',
    prepended.some((row) => row.number === '1200' && row.text.includes('line 1200')),
    prepended.find((row) => row.text.includes('line 1200')),
  );

  // Строка за концом файла: сообщение с фактическим числом строк, без перехода.
  await page.click('.line-input');
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.type('9999');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.search-bar .muted')].some((node) =>
        (node.textContent ?? '').replace(/\s+/g, ' ').includes('В файле 3 000 строк'),
      ),
    { timeout: 10000 },
  );
  check('строка за концом файла: сообщение, а не пустой экран', true);

  // Дописывание: tail-строки получают точные номера, индекс достраивается.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === 'в конец',
    );
    button?.click();
  });
  await page.waitForFunction(
    () => (document.querySelector('.status')?.textContent ?? '').includes('строк в буфере: 400'),
    { timeout: 15000 },
  );
  // Докручиваем до низа: без этого последняя строка может остаться за видимой частью.
  await page.evaluate(() => {
    const element = document.querySelector('.log');
    if (element) element.scrollTop = element.scrollHeight;
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.row')].some((row) => row.textContent?.includes('line 3000')),
    { timeout: 15000 },
  );
  await appendFile(file, '2026-11-13 10:00:01 INFO appended line 3001\n2026-11-13 10:00:02 INFO appended line 3002\n', 'utf8');
  // Сначала данные должны дойти до буфера, затем докручиваем: автоскролл зависит от
  // того, был ли пользователь внизу, и не должен влиять на проверку номеров.
  try {
    await page.waitForFunction(
      () => (document.querySelector('.status')?.textContent ?? '').includes('строк в буфере: 402'),
      { timeout: 20000 },
    );
  } catch (error) {
    const state = await page.evaluate(() => ({
      status: document.querySelector('.status')?.textContent ?? '',
      rows: document.querySelectorAll('.row').length,
      last: [...document.querySelectorAll('.row')].slice(-3).map((row) => row.textContent ?? ''),
    }));
    console.log('STATE-AFTER-APPEND', JSON.stringify(state));
    throw error;
  }
  await page.evaluate(() => {
    const element = document.querySelector('.log');
    if (element) element.scrollTop = element.scrollHeight;
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.row')].some((row) => row.textContent?.includes('line 3002')),
    { timeout: 15000 },
  );
  const appended = await rows(page);
  check('tail-строка 3002 получила точный номер', numberedCorrectly(appended), appended.slice(-3));
  check(
    'последняя строка буфера — 3002',
    appended[appended.length - 1]?.number === '3002',
    appended[appended.length - 1],
  );
  await page.waitForFunction(
    () =>
      (document.querySelector('.status')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .includes('строк в файле: 3 002'),
    { timeout: 20000 },
  );
  check('индекс достроен после дописывания', true);

  await page.screenshot({ path: join(process.cwd(), '.aplog', 'screenshots', 'lines.png') });
  console.log('screenshot: .aplog/screenshots/lines.png');
} finally {
  if (browser) await browser.close();
  if (tab?.id) await fetch(`${base}/api/v1/tabs/${tab.id}`, { method: 'DELETE' }).catch(() => undefined);
  if (original.activeTabId) {
    await send('POST', `/api/v1/tabs/${original.activeTabId}/activate`, {});
  }
  await send('PUT', '/api/v1/filters', { filters: originalFilters });
  await rm(file, { force: true });
  for (const cacheDir of cacheDirs) {
    let entries = [];
    try {
      entries = await readdir(cacheDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith('lines-') || !entry.endsWith('.json')) continue;
      const candidate = join(cacheDir, entry);
      try {
        const cache = JSON.parse(await readFile(candidate, 'utf8'));
        if (resolve(cache.path) === resolve(file)) await unlink(candidate);
      } catch {
        // чужой или битый кэш не трогаем
      }
    }
  }
}

process.exitCode = failed === 0 ? 0 : 1;
