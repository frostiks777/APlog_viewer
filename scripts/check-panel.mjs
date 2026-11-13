/**
 * Панель в браузере: правило добавляется, текст сохраняется автосейвом и переживает
 * перезагрузку; позиция чтения пишется в профиль и восстанавливается без tail.
 * Исходные правила, вкладка и панель восстанавливаются в finally.
 * Запуск: node scripts/check-panel.mjs [baseUrl]
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:7801';
const browserPath =
  process.env.APLOG_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const dir = join(process.cwd(), '.aplog', 'test');
const file = join(dir, 'panel.log');

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    console.log(`FAIL ${name}: ${JSON.stringify(detail)}`);
    failed += 1;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const originalTab = original.tabs.find((tab) => tab.id === original.activeTabId) ?? null;
let browser = null;
let testTab = null;

try {
  // Своя длинная фикстура: проверка позиции не должна зависеть от того,
  // какой файл случайно оказался активным в профиле.
  await mkdir(dir, { recursive: true });
  const lines = Array.from(
    { length: 1500 },
    (_, index) => `2026-11-13 10:00:00 INFO panel line ${index + 1}`,
  );
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  testTab = await send('POST', '/api/v1/tabs', { path: resolve(file) });

  await send('PATCH', '/api/v1/ui', { panels: { ...original.ui.panels, rulesOpen: true, rulesTab: 'highlight' } });

  browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('.rule', { timeout: 20000 });

  const before = await page.$$eval('.rule', (cards) => cards.length);
  await page.click('.panel-add');
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.rule').length === expected,
    { timeout: 5000 },
    before + 1,
  );
  check('кнопка «+ правило» добавляет карточку', true);

  await page.type('.rule-match', 'NEEDLE');
  await sleep(1600);

  let saved = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const profile = await get('/api/v1/profile');
    saved = profile.rules.find((rule) => rule.match === 'NEEDLE');
    if (saved) break;
    await sleep(200);
  }
  check('правило сохранено автосейвом', Boolean(saved), saved);

  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('.rule', { timeout: 20000 });
  const persisted = await page.$$eval('.rule-match', (inputs) => inputs.some((input) => input.value === 'NEEDLE'));
  check('правило видно после перезагрузки', persisted);

  const canScroll = await page.evaluate(() => {
    const log = document.querySelector('.log');
    if (!log) return false;
    log.scrollTop = Math.floor(log.scrollHeight / 2);
    return log.scrollTop > 0;
  });

  if (!canScroll) {
    console.log('SKIP позиция чтения: буфер целиком помещается на экран');
  } else {
    await sleep(1500);
    const profile = await get('/api/v1/profile');
    const tab = profile.tabs.find((item) => item.id === testTab.id);
    check('позиция чтения записана в профиль', Boolean(tab && tab.scrollOffset > 0), tab?.scrollOffset);

    await send('PATCH', `/api/v1/tabs/${tab.id}`, { tail: false, scrollOffset: tab.scrollOffset });
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('.row', { timeout: 20000 });

    const firstRow = await page.evaluate(() => document.querySelector('.row')?.textContent ?? '');
    const expected = await get(`/api/v1/tabs/${tab.id}/page?offset=${tab.scrollOffset}&lines=1`);
    check(
      'вкладка без tail открылась на сохранённой позиции',
      firstRow.includes((expected.lines[0]?.text ?? '').trim()),
      { firstRow, expected: expected.lines[0]?.text },
    );
  }
} finally {
  if (browser) await browser.close();
  await send('PUT', '/api/v1/rules', { rules: original.rules });
  await send('PATCH', '/api/v1/ui', { panels: original.ui.panels });
  if (testTab?.id) {
    await fetch(`${base}/api/v1/tabs/${testTab.id}`, { method: 'DELETE' }).catch(() => undefined);
  }
  if (originalTab) {
    await send('PATCH', `/api/v1/tabs/${originalTab.id}`, {
      tail: originalTab.tail,
      scrollOffset: originalTab.scrollOffset,
    });
    await send('POST', `/api/v1/tabs/${originalTab.id}/activate`, {});
  }
  await rm(file, { force: true });
}

process.exitCode = failed === 0 ? 0 : 1;
