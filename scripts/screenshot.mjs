/**
 * Скриншот работающего UI для визуальной проверки (пункт 5 чек-чейна).
 * Использует уже установленный Edge в headless-режиме, без скачивания Chromium.
 *
 * Запуск: node scripts/screenshot.mjs [url] [out.png]
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://127.0.0.1:7801';
const out = resolve(process.argv[3] ?? '.aplog/screenshots/app.png');

const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

const { existsSync } = await import('node:fs');
const executablePath = candidates.find((candidate) => existsSync(candidate));
if (!executablePath) {
  console.error('Не найден Edge/Chrome для headless-скриншота');
  process.exit(1);
}

await mkdir(dirname(out), { recursive: true });

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--disable-gpu', '--no-first-run', '--window-size=1500,900'],
  defaultViewport: { width: 1500, height: 900 },
});

try {
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('console:', message.text());
  });
  page.on('pageerror', (error) => console.error('pageerror:', error.message));

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll('.row').length > 0, { timeout: 20_000 });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  await page.screenshot({ path: out });
  console.log(`screenshot: ${out}`);
} finally {
  await browser.close();
}
