/**
 * Подсветка всех совпадений в буфере: маркеры по всему списку, текущее совпадение,
 * очистка, таймаут патологического regex и восстановление после смены запроса.
 * Вкладка и `ui.search` восстанавливаются в finally.
 * Запуск: node scripts/check-search-hits.mjs [baseUrl]
 */
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:7801';
const browserPath =
  process.env.APLOG_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const dir = join(process.cwd(), '.aplog', 'test');
const file = join(dir, 'search-hits.log');

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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json().catch(() => null);
}

const original = await get('/api/v1/profile');
const originalSearch = original.ui.search;
let browser = null;
let tab = null;

try {
  const lines = Array.from({ length: 3000 }, (_, index) => {
    const number = index + 1;
    if (number === 3) return `ERROR ${'a'.repeat(36)}b`;
    return number % 5 === 0
      ? `2026-11-13 10:00:00 HIT marker line ${number}`
      : `2026-11-13 10:00:00 INFO line ${number}`;
  });
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  // Детерминированное начальное состояние: проверка сама включает regex.
  await send('PATCH', '/api/v1/ui', {
    search: { isRegex: false, caseSensitive: true },
  });
  tab = await send('POST', '/api/v1/tabs', { path: resolve(file) });

  browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('.search-input', { timeout: 20000 });
  await page.waitForSelector('.row', { timeout: 20000 });

  // Начинаем с начала файла: буфер 1–400, в нём 80 совпадений HIT.
  for (const handle of await page.$$('button')) {
    if ((await handle.evaluate((element) => element.textContent?.trim())) !== 'в начало') continue;
    await handle.click();
    break;
  }
  await page.waitForFunction(() => document.querySelector('.row')?.textContent?.includes('line 1'), {
    timeout: 15000,
  });

  await page.click('.search-input');
  await page.type('.search-input', 'HIT');
  await page.waitForFunction(() => document.querySelectorAll('.row-hit').length >= 5, { timeout: 15000 });

  const initial = await page.evaluate(() => ({
    hits: document.querySelectorAll('.row-hit').length,
    allHit: [...document.querySelectorAll('.row-hit')].every((row) =>
      row.textContent?.includes('HIT'),
    ),
  }));
  check('маркеры появляются без Enter', initial.hits >= 5, initial);
  check('помечены только совпавшие строки', initial.allHit, initial);

  // Enter делает первое совпадение текущим; у него должны быть оба класса.
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.row-current') !== null, { timeout: 15000 });
  const current = await page.evaluate(() => {
    const row = document.querySelector('.row-current');
    return {
      text: row?.textContent ?? '',
      hit: row?.classList.contains('row-hit') ?? false,
      current: row?.classList.contains('row-current') ?? false,
    };
  });
  check('текущее совпадение тоже помечено как найденное', current.hit && current.current, current);
  check('текущее совпадение содержит HIT', current.text.includes('HIT'), current.text);

  // Прокрутка в середину: маркеры должны быть и вдали от текущего совпадения.
  await page.evaluate(() => {
    const log = document.querySelector('.log');
    if (log) log.scrollTop = Math.floor(log.scrollHeight / 2);
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
  const middle = await page.evaluate(() => ({
    hits: document.querySelectorAll('.row-hit').length,
    allHit: [...document.querySelectorAll('.row-hit')].every((row) =>
      row.textContent?.includes('HIT'),
    ),
    first: document.querySelector('.row')?.textContent ?? '',
  }));
  check('маркеры есть в середине буфера', middle.hits >= 5 && middle.allHit, middle);
  check(
    'середина списка действительно далеко от line 5',
    Number.parseInt(middle.first.match(/line (\d+)/)?.[1] ?? '0', 10) > 50,
    middle.first,
  );

  await page.screenshot({ path: join(process.cwd(), '.aplog', 'screenshots', 'search-hits.png') });
  console.log('screenshot: .aplog/screenshots/search-hits.png');

  // Tail: новая строка должна получить маркер по своему смещению, а не по индексу.
  for (const handle of await page.$$('button')) {
    if ((await handle.evaluate((element) => element.textContent?.trim())) !== 'в конец') continue;
    await handle.click();
    break;
  }
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.row')].some((row) => row.textContent?.includes('line 3000')),
    { timeout: 15000 },
  );
  await appendFile(file, '2026-11-13 10:00:01 HIT appended line 3001\n', 'utf8');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.row')].some((row) => row.textContent?.includes('line 3001')),
    { timeout: 15000 },
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.row-hit')].some((row) =>
        row.textContent?.includes('line 3001'),
      ),
    { timeout: 5000 },
  );
  check('tail-append получает маркер по смещению', true);

  // Очистка запроса убирает все маркеры. Фокус после «в конец» ушёл на кнопку,
  // поэтому сначала возвращаем его в поле.
  await page.click('.search-input');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.row-hit').length === 0, {
    timeout: 5000,
  });
  check('очистка запроса убирает маркеры', true);

  // Патологическая строка лежит в первой странице, а tail-тест увёл буфер в конец.
  for (const handle of await page.$$('button')) {
    if ((await handle.evaluate((element) => element.textContent?.trim())) !== 'в начало') continue;
    await handle.click();
    break;
  }
  await page.waitForFunction(
    () => document.querySelector('.row')?.textContent?.includes('line 1') ?? false,
    { timeout: 15000 },
  );

  // Патологический regex вводим без Enter: его должен убить воркер подсветки.
  await page.click('.search-bar .chip');
  await page.click('.search-input');
  await page.type('.search-input', '(a+)+$');
  await page.waitForFunction(
    () => document.querySelector('.search-bar')?.textContent?.includes('подсветка совпадений отключена') ?? false,
    { timeout: 5000 },
  );
  check('зависший regex отключает подсветку, а не интерфейс', true);
  const alive = await page.evaluate(() => 1 + 1);
  check('страница остаётся отзывчивой', alive === 2, alive);
  check('после таймаута маркеров нет', (await page.$$('.row-hit')).length === 0);

  // Смена запроса снимает блокировку и поднимает новый воркер.
  await page.keyboard.press('Escape');
  await page.type('.search-input', 'HIT');
  await page.waitForFunction(() => document.querySelectorAll('.row-hit').length >= 5, { timeout: 15000 });
  check('после смены запроса подсветка снова работает', true);
} finally {
  if (browser) await browser.close();
  if (tab?.id) await fetch(`${base}/api/v1/tabs/${tab.id}`, { method: 'DELETE' }).catch(() => undefined);
  if (original.activeTabId) {
    await send('POST', `/api/v1/tabs/${original.activeTabId}/activate`, {});
  }
  await send('PATCH', '/api/v1/ui', { search: originalSearch });
  await rm(file, { force: true });
}

process.exitCode = failed === 0 ? 0 : 1;
