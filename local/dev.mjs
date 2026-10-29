import { createServer as createViteServer } from 'vite';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { compileLocalDomain } from '../scripts/compile-local.mjs';
import { loadLocalEnvironment, projectRoot } from './env.mjs';
import { syncMiniProgramConfig } from './miniprogram.mjs';

loadLocalEnvironment();
process.chdir(projectRoot);
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') process.env.WEB_PORT = process.argv[++i];
  else if (process.argv[i] === '--api-port') process.env.API_PORT = process.argv[++i];
  else throw new Error(`Unknown option: ${process.argv[i]}`);
}
syncMiniProgramConfig();
compileLocalDomain();
const host = process.env.HOST || '127.0.0.1';
const apiPort = Number(process.env.API_PORT || 3001);
let apiProcess;
let stopping = false;
let restartTimer;
async function launchApi() {
  apiProcess = spawn(process.execPath, ['local/start.mjs', '--api-only'], { cwd: projectRoot, stdio: 'inherit', env: process.env });
  apiProcess.on('exit', code => { if (!stopping && code) { console.error(`API 进程退出（${code}），请检查上述错误。`); void shutdown(code); } });
  const address = `http://127.0.0.1:${apiPort}/api/setup`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await fetch(address); if (response.ok) return; } catch {}
    if (apiProcess.exitCode !== null) throw new Error('API 启动失败');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('API 未能在规定时间内启动');
}
let vite;
const watchers = [];
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  watchers.forEach(w => w.close());
  apiProcess?.kill('SIGTERM');
  if (vite) await vite.close();
  process.exitCode = code;
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
try {
  await launchApi();
  vite = await createViteServer({ configFile: path.join(projectRoot, 'vite.local.config.ts') });
  await vite.listen();
  console.log('\n练多多本地管理后台');
  vite.printUrls();
  console.log(`小程序 API: http://${host}:${apiPort}\n小程序使用微信登录；电脑后台保留账号密码。配置读取 app/.env。\n`);
  for (const directory of ['lib', 'server']) {
    try {
      watchers.push(watch(path.join(projectRoot, directory), { recursive: true }, () => {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(async () => {
          if (stopping) return;
          try {
            const previous = apiProcess;
            previous.removeAllListeners('exit');
            const exited = new Promise(resolve => previous.once('exit', resolve));
            previous.kill('SIGTERM');
            await exited;
            compileLocalDomain();
            await launchApi();
            console.log('本地 API 已重新加载');
          } catch (error) { console.error(error); await shutdown(1); }
        }, 250);
      }));
    } catch { console.log(`未启用 ${directory} 热重载；修改后重启 npm run dev。`); }
  }
} catch (error) { console.error(error); await shutdown(1); }
