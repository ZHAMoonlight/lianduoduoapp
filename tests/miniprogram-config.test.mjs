import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publicMiniConfig, syncMiniProgramConfig } from '../local/miniprogram.mjs';

test('微信公开配置只写白名单，保留项目设置且不泄露密钥', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'lianduoduo-public-config-'));
  writeFileSync(path.join(directory, 'project.config.json'), JSON.stringify({ appid: 'old', setting: { es6: true } }));
  syncMiniProgramConfig({ WECHAT_APP_ID: 'wx97ef043984618d67', WECHAT_APP_SECRET: 'never-bundle-test-secret', MINIPROGRAM_API_BASE_URL: 'https://example.test/', MINIPROGRAM_REQUEST_TIMEOUT_MS: '9000', DATABASE_PATH: '/private/data.sqlite' }, directory);
  const config = readFileSync(path.join(directory, 'config.js'), 'utf8');
  assert.match(config, /https:\/\/example.test/); assert.match(config, /9000/);
  assert.doesNotMatch(config, /never-bundle|SECRET|sqlite/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'project.config.json'), 'utf8')), { appid: 'wx97ef043984618d67', setting: { es6: true } });
});
test('拒绝带凭证、无效协议、无效 AppID 和请求超时配置', () => {
  for (const environment of [{ MINIPROGRAM_API_BASE_URL: 'https://secret@example.test' }, { MINIPROGRAM_API_BASE_URL: 'file:///tmp' }, { WECHAT_APP_ID: 'wrong' }, { MINIPROGRAM_REQUEST_TIMEOUT_MS: '-1' }]) assert.throws(() => publicMiniConfig(environment));
});

test('未填写生产 API 时保留原开发配置和返回结构', () => {
  const expected = { baseURL: 'http://127.0.0.1:43101', timeout: 15000, appid: '' };
  assert.deepEqual(publicMiniConfig({ API_PORT: '43101' }), expected);
  assert.deepEqual(publicMiniConfig({ API_PORT: '43101', MINIPROGRAM_PRODUCTION_API_BASE_URL: '' }), expected);
  const directory = mkdtempSync(path.join(tmpdir(), 'lianduoduo-dev-config-'));
  syncMiniProgramConfig({ API_PORT: '43101', MINIPROGRAM_PRODUCTION_API_BASE_URL: '' }, directory);
  assert.doesNotMatch(readFileSync(path.join(directory, 'config.js'), 'utf8'), /productionBaseURL/);
});

test('开发地址与生产地址分别保存，生产 URL 规范化且不带出服务端环境', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'lianduoduo-production-config-'));
  const environment = {
    MINIPROGRAM_API_BASE_URL: 'http://127.0.0.1:43101',
    MINIPROGRAM_PRODUCTION_API_BASE_URL: 'HTTPS://LIANDUODUO.EXAMPLE.TEST:443/api/',
    MYSQL_PASSWORD: 'never-bundle-mysql-password',
    MYSQL_ROOT_PASSWORD: 'never-bundle-root-password',
    WECHAT_APP_SECRET: 'never-bundle-wechat-secret',
    SETUP_TOKEN: 'never-bundle-setup-token',
  };
  assert.deepEqual(publicMiniConfig(environment), { baseURL: 'http://127.0.0.1:43101', productionBaseURL: 'https://lianduoduo.example.test/api', timeout: 15000, appid: '' });
  syncMiniProgramConfig(environment, directory);
  const source = readFileSync(path.join(directory, 'config.js'), 'utf8');
  const output = JSON.parse(source.slice(source.indexOf('module.exports = ') + 'module.exports = '.length).replace(/;\s*$/, ''));
  assert.deepEqual(output, { baseURL: 'http://127.0.0.1:43101', timeout: 15000, productionBaseURL: 'https://lianduoduo.example.test/api' });
  assert.doesNotMatch(source, /never-bundle|MYSQL|SECRET|SETUP_TOKEN/);
});

test('生产地址拒绝本机及等价编码，避免体验版请求手机自身', () => {
  for (const value of [
    'https://localhost', 'https://LOCALHOST.', 'https://api.localhost', 'https://localhost.localdomain', 'https://api.localhost.localdomain', 'https://ip6-localhost', 'https://ip6-loopback',
    'https://127.0.0.1', 'https://127.18.25.64', 'https://127.1', 'https://2130706433',
    'https://0x7f000001', 'https://0177.0.0.1', 'https://%6cocalhost', 'https://0', 'https://0.0.0.0',
    'https://[::]', 'https://[::1]', 'https://[0:0:0:0:0:0:0:1]',
    'https://[::ffff:127.0.0.1]', 'https://[::ffff:127.4.5.6]', 'https://[::ffff:7f00:1]',
    'https://[::127.0.0.1]', 'https://[::ffff:0.0.0.0]',
  ]) {
    assert.throws(() => publicMiniConfig({ MINIPROGRAM_PRODUCTION_API_BASE_URL: value }), /MINIPROGRAM_PRODUCTION_API_BASE_URL/, value);
  }
});

test('生产地址须为 HTTPS，禁止凭证、查询参数和片段', () => {
  for (const value of [
    'http://example.test', 'ftp://example.test', 'file:///tmp', 'not-a-url', ' ', 'https://example.test:0',
    'https://user:password@example.test', 'https://user@example.test',
    'https://example.test?token=test', 'https://example.test#fragment', 'https://example.test/?', 'https://example.test/#',
  ]) {
    assert.throws(() => publicMiniConfig({ MINIPROGRAM_PRODUCTION_API_BASE_URL: value }), /MINIPROGRAM_PRODUCTION_API_BASE_URL/, value);
  }
  assert.equal(publicMiniConfig({ MINIPROGRAM_PRODUCTION_API_BASE_URL: 'https://example.test:8443/api' }).productionBaseURL, 'https://example.test:8443/api');
});
