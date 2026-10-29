import path from 'node:path';
import { existsSync } from 'node:fs';
import { compileLocalDomain } from '../scripts/compile-local.mjs';
import { loadLocalEnvironment, projectRoot } from './env.mjs';
import { syncMiniProgramConfig } from './miniprogram.mjs';

loadLocalEnvironment();
if (process.env.DB_CLIENT && process.env.DB_CLIENT !== 'mysql') throw new Error('本地业务服务使用 MySQL，请将 .env 的 DB_CLIENT 设置为 mysql。');
process.chdir(projectRoot);
const apiOnly = process.argv.includes('--api-only');
const args = process.argv.slice(2).filter(v => v !== '--api-only');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') process.env.API_PORT = args[++i];
  else throw new Error(`Unknown option: ${args[i]}`);
}
if (!apiOnly) compileLocalDomain();
syncMiniProgramConfig();
const { createLocalServer } = await import('../server/app.mjs');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.API_PORT || 3001);
const staticDir = apiOnly ? undefined : path.join(projectRoot, 'dist-local/client');
if (!apiOnly && !existsSync(path.join(staticDir, 'index.html'))) throw new Error('请先执行 npm run build，再执行 npm start。');
const server = await createLocalServer({ staticDir });
server.on('error', error => { console.error(`本地 API 启动失败：${error.message}`); process.exitCode = 1; });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
console.log(`本地${apiOnly ? ' API' : '应用'}: http://${host}:${port}`);
function stop() { server.close(() => { void server.closeDatabase?.().catch(error => { console.error('关闭数据库失败：', error.code || error.message); process.exitCode = 1; }); }); server.closeIdleConnections?.(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
