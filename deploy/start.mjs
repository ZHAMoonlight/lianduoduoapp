import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLocalServer } from '../server/app.mjs';

if (process.env.DB_CLIENT !== 'mysql') throw new Error('Production requires DB_CLIENT=mysql.');
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.API_PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API_PORT is invalid.');
const staticDir = fileURLToPath(new URL('../dist-local/client/', import.meta.url));
if (!existsSync(new URL('../dist-local/client/index.html', import.meta.url))) throw new Error('The production client build is missing.');

const server = await createLocalServer({ staticDir });
server.on('error', error => { console.error('Application server failed:', error.code || error.message); process.exitCode = 1; });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
console.log(`Lianduoduo application listening on ${host}:${port}`);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void server.closeDatabase?.().catch(error => { console.error('Database shutdown failed:', error.code || error.message); process.exitCode = 1; });
  });
  server.closeIdleConnections?.();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
