/**
 * Проверка жизненного цикла файла на API: append / truncate / replace (ротация).
 * Запуск: node scripts/check-rotation.mjs [baseUrl]
 */
import { mkdir, rename, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:7801';
const dir = join(process.cwd(), '.aplog', 'test');
await mkdir(dir, { recursive: true });

const path = join(dir, 'rotation.log');
let failed = 0;

async function addTab(filePath) {
  const response = await fetch(`${base}/api/v1/tabs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  });
  if (!response.ok) throw new Error(`не удалось добавить вкладку: ${await response.text()}`);
  return response.json();
}

async function tail(id, offset) {
  const response = await fetch(`${base}/api/v1/tabs/${id}/tail?offset=${offset}`);
  if (!response.ok) throw new Error(`tail: ${response.status} ${await response.text()}`);
  return response.json();
}

function check(name, condition, actual) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    console.log(`FAIL ${name}: ${JSON.stringify(actual)}`);
    failed += 1;
  }
}

await rm(path, { force: true });
await writeFile(path, 'line1\nline2\nline3\n', 'utf8');
const tab = await addTab(resolve(path));

let page = await tail(tab.id, 0);
check('начальное чтение', page.lines.length === 3 && page.event === 'ok', {
  lines: page.lines.length,
  event: page.event,
});

const afterAppend = page.endOffset;
await writeFile(path, `${await (await import('node:fs/promises')).readFile(path, 'utf8')}line4\n`, 'utf8');
page = await tail(tab.id, afterAppend);
check('append: одна новая строка', page.lines.length === 1 && page.lines[0].text === 'line4', page.lines);

await writeFile(path, 'x\n', 'utf8');
page = await tail(tab.id, page.endOffset);
check('truncate: событие и пустой хвост', page.event === 'truncated' && page.size === 2, {
  event: page.event,
  size: page.size,
});

const replacement = `${path}.new`;
await writeFile(replacement, 'other\n', 'utf8');
await rename(replacement, path);
page = await tail(tab.id, page.endOffset);
check('replace: событие rotated и чтение нового файла', page.event === 'rotated' && page.lines[0]?.text === 'other', {
  event: page.event,
  lines: page.lines,
});

await fetch(`${base}/api/v1/tabs/${tab.id}`, { method: 'DELETE' });
await rm(path, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
