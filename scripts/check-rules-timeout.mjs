/**
 * Проверка защиты от патологического regex: правило, которое вешает матчинг, должно быть
 * убито по таймауту, сохранено с disabledReason и не мешать остальным правилам.
 * Запуск: node scripts/check-rules-timeout.mjs [baseUrl]
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:7801';
const browserPath =
  process.env.APLOG_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const dir = join(process.cwd(), '.aplog', 'test');
const file = join(dir, 'timeout.log');
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
const errorRule = {
  id: 'timeout-good',
  enabled: true,
  match: 'ERROR',
  isRegex: false,
  caseSensitive: true,
  invert: false,
  fg: '#ffffff',
  bg: '#b3261e',
  bold: true,
  priority: 90,
  scope: 'global',
  tabId: null,
};
// (a+)+$ на строке из 'a' уходит в экспоненциальный бэктрекинг.
const badRule = {
  id: 'timeout-bad',
  enabled: true,
  match: '(a+)+$',
  isRegex: true,
  caseSensitive: true,
  invert: false,
  fg: '#ffffff',
  bg: '#004400',
  bold: false,
  priority: 100,
  scope: 'global',
  tabId: null,
};

let tab = null;
let browser = null;

try {
  const lines = Array.from({ length: 300 }, () => `ERROR ${'a'.repeat(36)}b`).join('\n');
  await writeFile(file, `${lines}\n`, 'utf8');

  // Только эти два правила: штатное ERROR-правило с тем же приоритетом раскрасило бы
  // строки раньше, и патологический паттерн не дошёл бы до матчинга.
  await send('PUT', '/api/v1/rules', { rules: [badRule, errorRule] });
  await send('PATCH', '/api/v1/ui', { panels: { ...original.ui.panels, rulesOpen: true, rulesTab: 'highlight' } });
  tab = await send('POST', '/api/v1/tabs', { path: resolve(file) });

  browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-first-run'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });

  const started = Date.now();
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.row').length > 0, { timeout: 20000 });
  check('страница отрисовала строки', true);

  await page.waitForFunction(
    () => document.body.textContent?.includes('слишком медленное') ?? false,
    { timeout: 15000 },
  );
  const elapsed = Date.now() - started;
  check('правило отключено по таймауту за разумное время', elapsed < 15000, elapsed);

  const background = await page.evaluate(() => {
    const row = document.querySelector('.row');
    return row ? getComputedStyle(row).backgroundColor : null;
  });
  check('остальные правила продолжают работать', background === 'rgb(179, 38, 30)', background);

  let persisted = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const profile = await get('/api/v1/profile');
    persisted = profile.rules.find((rule) => rule.id === 'timeout-bad');
    if (persisted?.disabledReason === 'timeout') break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  check('таймаут сохранён в профиль', persisted?.disabledReason === 'timeout', persisted);
} finally {
  if (browser) await browser.close();
  if (tab?.id) await fetch(`${base}/api/v1/tabs/${tab.id}`, { method: 'DELETE' });
  await send('PUT', '/api/v1/rules', { rules: original.rules });
  await send('PATCH', '/api/v1/ui', { panels: original.ui.panels });
  await rm(file, { force: true });
}

process.exitCode = failed === 0 ? 0 : 1;
