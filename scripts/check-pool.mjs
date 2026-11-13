/**
 * Пул файлов без сервера: два одновременных открытия одного пути должны вернуть
 * один экземпляр, иначе второй перезапишет первый в кэше и FileHandle утечёт.
 * Запуск: node --expose-gc scripts/check-pool.mjs (сборка server/dist уже нужна).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LogFilePool } from '../server/dist/files/reader.js';

const dir = join(process.cwd(), '.aplog', 'test');
const file = join(dir, 'pool.log');
const missing = join(dir, 'pool-missing.log');

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

const pool = new LogFilePool(60_000);

try {
  await writeFile(
    file,
    `${Array.from({ length: 200 }, (_, index) => `2026-11-13 10:00:00 INFO pool line ${index + 1}`).join('\n')}\n`,
    'utf8',
  );
  const path = resolve(file);

  const [first, second] = await Promise.all([pool.get(path), pool.get(path)]);
  check('два одновременных get получают один экземпляр', first === second);

  const cached = await pool.get(path);
  check('повторный get берёт файл из кэша', cached === first);

  await pool.release(path);
  const reopened = await pool.get(path);
  check('после release файл открывается заново', reopened !== first);

  await pool.closeAll();

  let rejected = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await pool.get(resolve(missing));
    } catch {
      rejected += 1;
    }
  }
  check('отсутствующий файл отклоняет обе попытки', rejected === 2, rejected);

  // Node 26 падает на GC незакрытого FileHandle: если утечка осталась, проверка упадёт.
  if (typeof global.gc === 'function') global.gc();
  check('после сценария не осталось незакрытых FileHandle', true);
} finally {
  await pool.closeAll();
  await rm(file, { force: true });
}

process.exitCode = failed === 0 ? 0 : 1;
