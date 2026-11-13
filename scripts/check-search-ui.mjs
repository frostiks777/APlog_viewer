/**
 * Поиск в браузере: Enter находит совпадение, F3/Shift+F3 ходят по файлу,
 * переход вне загруженного буфера догружает страницу, флаги поиска переживают reload.
 * Вкладка и `ui.search` восстанавливаются в finally.
 * Запуск: node scripts/check-search-ui.mjs [baseUrl]
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:7801';
const browserPath =
  process.env.APLOG_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const dir = join(process.cwd(), '.aplog', 'test');
const file = join(dir, 'search-ui.log');

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
    const level = number === 10 || number === 500 || number === 999 ? 'ERROR' : 'INFO';
    return `2026-11-13 10:00:00 ${level} line ${number}`;
  });
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  tab = await send('POST', '/api/v1/tabs', { path: resolve(file) });

  browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('.search-input', { timeout: 20000 });
  await page.waitForSelector('.row', { timeout: 20000 });

  // Начинаем с начала файла: иначе tail открывает конец, и line 10 позади курсора.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === 'в начало',
    );
    button?.click();
  });
  await page.waitForFunction(
    () => document.querySelector('.row')?.textContent?.includes('line 1'),
    { timeout: 15000 },
  );

  await page.click('.search-input');
  await page.type('.search-input', 'ERROR');
  await page.keyboard.press('Enter');

  await page.waitForFunction(
    () => document.querySelector('.row-current')?.textContent?.includes('line 10') ?? false,
    { timeout: 15000 },
  );
  check('Enter находит первое совпадение', true);
  check(
    'счётчик показывает позицию и число',
    /^1 \/ 3\+?$/.test((await page.$eval('.search-count', (el) => el.textContent ?? '')).trim()),
    await page.$eval('.search-count', (el) => el.textContent),
  );

  await page.keyboard.press('F3');
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector('.row-current')?.textContent?.includes('line 500') &&
          document.querySelector('.row')?.textContent?.includes('line 500'),
      ),
    { timeout: 15000 },
  );
  check('F3 переходит к совпадению вне буфера', true);
  const firstRowAfterJump = await page.$eval('.row', (el) => el.textContent ?? '');
  check(
    'вне буфера догружена страница с нужной строкой',
    Number.parseInt(firstRowAfterJump.match(/line (\d+)/)?.[1] ?? '0', 10) > 400,
    firstRowAfterJump,
  );

  await page.keyboard.press('F3');
  await page.waitForFunction(
    () => document.querySelector('.row-current')?.textContent?.includes('line 999') ?? false,
    { timeout: 15000 },
  );
  check(
    'F3 доходит до последнего совпадения',
    /^3 \/ 3\+?$/.test((await page.$eval('.search-count', (el) => el.textContent ?? '')).trim()),
    await page.$eval('.search-count', (el) => el.textContent),
  );

  await page.keyboard.press('F3');
  await page.waitForFunction(
    () => document.querySelector('.search-bar .muted')?.textContent?.includes('Ниже совпадений нет') ?? false,
    { timeout: 10000 },
  );
  check('после последнего совпадения — сообщение, а не поиск по кругу', true);

  await page.keyboard.down('Shift');
  await page.keyboard.press('F3');
  await page.keyboard.up('Shift');
  await page.waitForFunction(
    () => document.querySelector('.row-current')?.textContent?.includes('line 500') ?? false,
    { timeout: 15000 },
  );
  check('Shift+F3 возвращает к предыдущему совпадению', true);

  // Флаги поиска — часть рабочего пространства.
  await page.click('.search-bar .chip');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
  const saved = await get('/api/v1/profile');
  check('флаг regex сохранён в профиль', saved.ui.search.isRegex === true, saved.ui.search);

  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('.search-input', { timeout: 20000 });
  const regexOn = await page.$eval('.search-bar .chip', (el) => el.classList.contains('chip-on'));
  check('флаг regex восстановлен после reload', regexOn === true);

  await page.screenshot({ path: join(process.cwd(), '.aplog', 'screenshots', 'search.png') });
  console.log('screenshot: .aplog/screenshots/search.png');
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
