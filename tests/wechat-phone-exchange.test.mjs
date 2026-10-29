import test from 'node:test';
import assert from 'node:assert/strict';
import { createWechatPhoneExchange, validateWechatPhoneResult } from '../server/wechat-phone.mjs';

const now = new Date('2026-10-28T10:00:00Z');
const valid = () => ({ errcode: 0, phone_info: { purePhoneNumber: '13900000000', phoneNumber: '+8613900000000', countryCode: '86', watermark: { appid: 'test-app', timestamp: now.getTime() / 1000 } } });
const response = result => ({ ok: true, json: async () => result });
const opts = fetcher => ({ appId: 'test-app', appSecret: 'private-secret', clock: () => now, fetcher });

test('validated upstream phone is mainland and bound to this app and recent timestamp', () => {
  assert.equal(validateWechatPhoneResult(valid(), { appId: 'test-app', now }), '13900000000');
  for (const mutate of [
    info => { info.watermark.appid = 'other-app'; },
    info => { info.watermark.timestamp -= 601; },
    info => { info.watermark.timestamp += 61; },
    info => { info.watermark.timestamp = String(info.watermark.timestamp); },
    info => { info.countryCode = '1'; },
    info => { info.purePhoneNumber = 13900000000; },
    info => { info.phoneNumber = '+8613900000001'; },
    info => { delete info.watermark; },
  ]) {
    const value = valid(); mutate(value.phone_info);
    assert.throws(() => validateWechatPhoneResult(value, { appId: 'test-app', now }), error => error.status === 502);
  }
  assert.throws(() => validateWechatPhoneResult({ phone_info: {} }, { appId: 'test-app', now }), error => error.status === 502);
});

test('stable access token is private, cached and single flight while phone requests carry their own codes', async () => {
  const calls = [];
  const exchange = createWechatPhoneExchange(opts(async (url, request) => {
    calls.push({ url, request });
    if (url.includes('stable_token')) {
      await new Promise(resolve => setTimeout(resolve, 10));
      return response({ access_token: 'private-token', expires_in: 7200 });
    }
    return response(valid());
  }));
  await Promise.all([exchange('code-a'), exchange('code-b')]);
  await exchange('code-c');
  assert.equal(calls.filter(call => call.url.includes('stable_token')).length, 1);
  assert.deepEqual(JSON.parse(calls[0].request.body), { grant_type: 'client_credential', appid: 'test-app', secret: 'private-secret', force_refresh: false });
  assert.deepEqual(calls.slice(1).map(call => JSON.parse(call.request.body)), [{ code: 'code-a' }, { code: 'code-b' }, { code: 'code-c' }]);
  assert.ok(calls.slice(1).every(call => call.url === 'https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=private-token'));
  assert.ok(calls.every(call => call.request.method === 'POST' && call.request.redirect === 'error' && call.request.signal instanceof AbortSignal));
});

test('expired cached token is fetched again using ordinary stable mode', async () => {
  let millis = now.getTime(), tokens = 0;
  const exchange = createWechatPhoneExchange({ ...opts(async url => url.includes('stable_token') ? (tokens++, response({ access_token: `token-${tokens}`, expires_in: 120 })) : response(valid())), clock: () => new Date(millis) });
  await exchange('a'); millis += 61000; await exchange('b');
  assert.equal(tokens, 2);
});

test('definitive token rejection refreshes only once and retries the unchanged phone code', async () => {
  const calls = []; let phoneCalls = 0;
  const exchange = createWechatPhoneExchange(opts(async (url, request) => {
    calls.push({ url, body: JSON.parse(request.body) });
    if (url.includes('stable_token')) return response({ access_token: calls.length === 1 ? 'old' : 'fresh', expires_in: 7200 });
    return response(++phoneCalls === 1 ? { errcode: 42001, errmsg: 'private raw upstream error' } : valid());
  }));
  assert.deepEqual(await exchange('same-code'), valid());
  assert.equal(calls.length, 4);
  assert.equal(calls[2].body.force_refresh, true);
  assert.deepEqual(calls[1].body, calls[3].body);
  assert.ok(calls[3].url.endsWith('access_token=fresh'));
});

test('a second invalid access token does not recurse indefinitely', async () => {
  let calls = 0;
  const exchange = createWechatPhoneExchange(opts(async url => { calls++; return response(url.includes('stable_token') ? { access_token: 'bad', expires_in: 7200 } : { errcode: 40014 }); }));
  await assert.rejects(exchange('once'), error => error.status === 503);
  assert.equal(calls, 4);
});

test('phone code errors do not become session 401 and never disclose raw upstream details', async () => {
  let phones = 0;
  const exchange = createWechatPhoneExchange(opts(async url => response(url.includes('stable_token') ? { access_token: 'private-token', expires_in: 7200 } : (phones++, { errcode: 40029, errmsg: 'private-secret private-token 13900000000' }))));
  await assert.rejects(exchange('private-code'), error => error.status === 400 && !/private|13900000000/.test(error.message));
  assert.equal(phones, 1);
});

test('network, HTTP and malformed JSON failures are sanitised and phone calls never replay', async () => {
  for (const fail of [() => { throw new Error('private-token private-code'); }, () => ({ ok: false }), () => ({ ok: true, json: async () => { throw new Error('private phone'); } })]) {
    let phones = 0;
    const exchange = createWechatPhoneExchange(opts(async url => url.includes('stable_token') ? response({ access_token: 'private-token', expires_in: 7200 }) : (phones++, fail())));
    await assert.rejects(exchange('private-code'), error => error.status === 502 && !/private/.test(error.message));
    assert.equal(phones, 1);
  }
});

test('configuration, capability and token credentials errors give actionable server errors', async () => {
  await assert.rejects(createWechatPhoneExchange({ appId: '', appSecret: '' })('a'), error => error.status === 503);
  for (const errcode of [48001, 48002, 45009]) {
    const exchange = createWechatPhoneExchange(opts(async url => response(url.includes('stable_token') ? { access_token: 'token', expires_in: 7200 } : { errcode })));
    await assert.rejects(exchange('a'), error => error.status === 503);
  }
  const exchange = createWechatPhoneExchange(opts(async () => response({ errcode: 40164, errmsg: 'private IP or secret' })));
  await assert.rejects(exchange('a'), error => error.status === 503 && error.message.includes('白名单') && !/private/.test(error.message));
});
