import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { HANDLE_IDLE_MS, HOST, PORT, WEB_DIST } from './config.js';
import { LogFilePool } from './files/reader.js';
import { registerRoutes } from './api/routes.js';

const pool = new LogFilePool(HANDLE_IDLE_MS);
const app = Fastify({ logger: { level: process.env.APLOG_LOG_LEVEL ?? 'info' } });

/**
 * Защита локального API от запросов чужих страниц (DNS rebinding / CSRF на localhost).
 * Токен для одного пользователя ничего не добавляет: процесс того же пользователя
 * всё равно прочитает профиль. А Host/Origin отсекают именно браузерный вектор.
 */
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  '127.0.0.1:5173',
  'localhost:5173',
]);
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);

app.addHook('onRequest', async (request, reply) => {
  const host = String(request.headers.host ?? '');
  if (!ALLOWED_HOSTS.has(host)) {
    return reply.code(403).send({ error: 'Недопустимый Host' });
  }
  const origin = request.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return reply.code(403).send({ error: 'Недопустимый Origin' });
  }
  return undefined;
});

app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  const status = error.statusCode ?? 500;
  if (status >= 500) app.log.error(error);
  reply.code(status).send({ error: error.message });
});

await registerRoutes(app, pool);

if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST, prefix: '/' });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Не найдено' });
  });
}

const keepAlive = setInterval(() => {
  void pool.closeIdle();
}, 60_000);
keepAlive.unref();

await app.listen({ host: HOST, port: PORT });
app.log.info(`APlog Viewer: http://${HOST}:${PORT}`);

if (!process.env.APLOG_NO_BROWSER && existsSync(WEB_DIST)) {
  spawn('cmd', ['/c', 'start', '', `http://${HOST}:${PORT}`], { detached: true, stdio: 'ignore' }).unref();
}

async function shutdown(signal: string): Promise<void> {
  app.log.info(`Остановка по ${signal}`);
  clearInterval(keepAlive);
  await app.close();
  await pool.closeAll();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
