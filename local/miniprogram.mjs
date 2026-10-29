import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadLocalEnvironment } from './env.mjs';

function productionServiceURL(value) {
  const message = 'MINIPROGRAM_PRODUCTION_API_BASE_URL 必须是没有账号、查询参数和片段的 HTTPS 服务地址，且不能使用本机地址。';
  let address;
  try { if (typeof value !== 'string') throw new Error(message); address = new URL(value); }
  catch { throw new Error(message); }
  const host = address.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const local = host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.localdomain' || host.endsWith('.localhost.localdomain') || ['ip6-localhost', 'ip6-loopback'].includes(host) || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '0.0.0.0' || host === '::' || host === '::1' || host === '::ffff:0:0' || /^::(?:ffff:)?7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host);
  if (address.protocol !== 'https:' || !host || local || address.port === '0' || address.username || address.password || /[?#]/.test(value)) throw new Error(message);
  return address.href.replace(/\/$/, '');
}

// Only public values may enter the mini-program bundle. AppSecret stays in .env.
export function publicMiniConfig(environment = process.env) {
  const baseURL = environment.MINIPROGRAM_API_BASE_URL || `http://127.0.0.1:${environment.API_PORT || 3001}`;
  const address = new URL(baseURL);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error('MINIPROGRAM_API_BASE_URL 必须是没有账号、查询参数和片段的 HTTP(S) 地址。');
  const timeout = Number(environment.MINIPROGRAM_REQUEST_TIMEOUT_MS || 15000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) throw new Error('MINIPROGRAM_REQUEST_TIMEOUT_MS 必须为 1000–120000 毫秒整数。');
  const appid = environment.WECHAT_APP_ID || '';
  if (appid && !/^wx[0-9a-f]{16}$/i.test(appid)) throw new Error('WECHAT_APP_ID 格式无效。');
  const production = environment.MINIPROGRAM_PRODUCTION_API_BASE_URL;
  const productionBaseURL = production === undefined || production === '' ? undefined : productionServiceURL(production);
  return { baseURL: baseURL.replace(/\/$/, ''), timeout, appid, ...(productionBaseURL ? { productionBaseURL } : {}) };
}

export function syncMiniProgramConfig(environment = process.env, directory = fileURLToPath(new URL('../../miniprogram/', import.meta.url))) {
  const { baseURL, timeout, appid, productionBaseURL } = publicMiniConfig(environment);
  const writeChanged = (name, contents) => {
    const target = path.join(directory, name);
    if (!existsSync(target) || readFileSync(target, 'utf8') !== contents) writeFileSync(target, contents);
  };
  writeChanged('config.js', `// Generated from app/.env by npm run config:wechat. Contains public configuration only.\nmodule.exports = ${JSON.stringify({ baseURL, timeout, ...(productionBaseURL ? { productionBaseURL } : {}) }, null, 2)};\n`);
  if (appid) {
    const target = path.join(directory, 'project.config.json');
    const project = JSON.parse(readFileSync(target, 'utf8'));
    project.appid = appid;
    writeChanged('project.config.json', `${JSON.stringify(project, null, 2)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  loadLocalEnvironment();
  syncMiniProgramConfig();
  console.log('微信小程序公开配置已从 app/.env 同步；密钥仅供服务端读取。');
}
