/**
 * Проверка кодировок и границ строк на реальном API: UTF-8 BOM, UTF-16LE/BE, cp1251.
 * Запуск: node scripts/check-encodings.mjs [baseUrl]
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import iconv from 'iconv-lite';

const base = process.argv[2] ?? 'http://127.0.0.1:7801';
const dir = join(process.cwd(), '.aplog', 'test');
await mkdir(dir, { recursive: true });

const LINES = [
  '2026-11-13 10:00:00 INFO (T) : Первая строка',
  '2026-11-13 10:00:01 ERROR (T) : Вторая строка',
  'Третья без перевода',
];
const text = `${LINES[0]}\r\n${LINES[1]}\r\n${LINES[2]}`;

function utf16be(value) {
  const le = Buffer.from(value, 'utf16le');
  for (let i = 0; i < le.length; i += 2) {
    const a = le[i];
    le[i] = le[i + 1];
    le[i + 1] = a;
  }
  return le;
}

function cp1251(value) {
  return iconv.encode(value, 'win1251');
}

const cases = [
  ['utf8-bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]), 'utf-8'],
  ['utf16le', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]), 'utf-16le'],
  ['utf16be', Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(text)]), 'utf-16be'],
  ['cp1251', cp1251(text), 'cp1251'],
];

let failed = 0;
for (const [name, bytes, expectedEncoding] of cases) {
  const path = join(dir, `${name}.log`);
  await writeFile(path, bytes);

  const created = await fetch(`${base}/api/v1/tabs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const tab = await created.json();
  if (!created.ok) {
    console.log(`FAIL ${name}: ${tab.error}`);
    failed += 1;
    continue;
  }

  const response = await fetch(`${base}/api/v1/tabs/${tab.id}/page?offset=0&lines=10`);
  const page = await response.json();
  const texts = page.lines.map((line) => line.text);
  const ok =
    page.encoding === expectedEncoding &&
    texts.length === 3 &&
    texts[0].endsWith(LINES[0]) &&
    texts[1].endsWith(LINES[1]) &&
    texts[2] === LINES[2];

  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: enc=${page.encoding} lines=${texts.length}`);
  if (!ok) {
    failed += 1;
    texts.forEach((value, index) => console.log(`  [${index}] ${JSON.stringify(value)}`));
  }

  await fetch(`${base}/api/v1/tabs/${tab.id}`, { method: 'DELETE' });
  await rm(path, { force: true });
}

process.exitCode = failed === 0 ? 0 : 1;
