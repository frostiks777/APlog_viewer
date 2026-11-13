/**
 * Фильтр в браузере: include оставляет только совпадения, буфер сам догружается до начала
 * файла, счётчики совпадают с фикстурой (2000 строк, каждый 100-й — ERROR).
 * Запуск: node scripts/check-filter.mjs [baseUrl]
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:7801';
const browserPath =
  process.env.APLOG_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const dir = join(process.cwd(), '.aplog', 'test');
const file = join(dir, 'filter.log');
const TOTAL = 2000;
const MATCHES = TOTAL / 100;

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
let tab = null;
let browser = null;

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
        id: 'filter-check',
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
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });

  await page.waitForSelector('.filter-bar', { timeout: 20000 });
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.row').length === expected,
    { timeout: 30000 },
    MATCHES,
  );

  const state = await page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('.row')).map((row) => row.textContent ?? ''),
    bar: (document.querySelector('.filter-bar')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    status: (document.querySelector('.status')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }));

  check('показаны только совпадения', state.rows.length === MATCHES && state.rows.every((text) => text.includes('ERROR')), state.rows.slice(0, 3));
  check(
    'счётчик фильтра: все строки файла просмотрены',
    state.bar.includes(`${MATCHES} из 2 000`),
    state.bar,
  );
  check('в статусе есть счётчик показанных', state.status.includes(`показано: ${MATCHES}`), state.status);

  await page.screenshot({ path: join(process.cwd(), '.aplog', 'screenshots', 'filter.png') });
  console.log('screenshot: .aplog/screenshots/filter.png');
} finally {
  if (browser) await browser.close();
  if (tab?.id) await fetch(`${base}/api/v1/tabs/${tab.id}`, { method: 'DELETE' });
  await send('PUT', '/api/v1/filters', { filters: original.filters });
  await rm(file, { force: true });
}

process.exitCode = failed === 0 ? 0 : 1;
