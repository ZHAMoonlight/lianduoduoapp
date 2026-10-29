// Secrets and access tokens stay in this server-only module; callers receive only
// a validated phone response or a deliberately sanitised error.
function failure(message, status) {
  return Object.assign(new Error(message), { status });
}

const TOKEN_INVALID = new Set([40001, 40014, 42001]);
function phoneFailure(code) {
  if ([48001, 48002, 48006, 48004].includes(Number(code))) return failure('当前小程序尚未开通微信手机号能力，请联系管理员检查微信后台权限。', 503);
  if (Number(code) === 45009) return failure('微信手机号接口调用额度不足，请联系管理员。', 503);
  return failure('微信手机号授权凭证无效或已过期，请重新授权。', 400);
}

export function validateWechatPhoneResult(result, { appId, now = new Date() } = {}) {
  if (result?.errcode && Number(result.errcode) !== 0) throw phoneFailure(result.errcode);
  const info = result?.phone_info;
  const time = new Date(now).getTime();
  const stamp = info?.watermark?.timestamp;
  const phone = info?.purePhoneNumber;
  const full = typeof info?.phoneNumber === 'string' ? info.phoneNumber.replace(/^\+?86(?=1[3-9]\d{9}$)/, '') : undefined;
  if (!appId || !info || typeof phone !== 'string' || !/^1[3-9]\d{9}$/.test(phone) || String(info.countryCode) !== '86' ||
    (info.phoneNumber !== undefined && full !== phone) || info.watermark?.appid !== appId ||
    !Number.isFinite(time) || !Number.isInteger(stamp) || stamp * 1000 < time - 600000 || stamp * 1000 > time + 60000) {
    throw failure('微信返回的手机号信息校验失败，请重新授权。', 502);
  }
  return phone;
}

export function createWechatPhoneExchange({
  appId = process.env.WECHAT_APP_ID,
  appSecret = process.env.WECHAT_APP_SECRET,
  clock = () => new Date(),
  timeoutMs = Number(process.env.WECHAT_API_TIMEOUT_MS || 10000),
  fetcher = globalThis.fetch,
} = {}) {
  let cached;
  let pending;
  async function post(url, body) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw failure('微信接口超时配置无效，请检查 .env。', 503);
    try {
      const response = await fetcher(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      });
      if (!response.ok) throw failure('微信服务暂时不可用，请稍后重新授权。', 502);
      const result = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw failure('微信服务返回异常，请稍后重新授权。', 502);
      return result;
    } catch (error) {
      if (error?.status === 502) throw error;
      throw failure('微信服务连接失败或超时，请稍后重新授权。', 502);
    }
  }
  async function accessToken(forceRefresh = false) {
    if (!forceRefresh && cached && cached.expiresAt > new Date(clock()).getTime()) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const result = await post('https://api.weixin.qq.com/cgi-bin/stable_token', {
        grant_type: 'client_credential', appid: appId, secret: appSecret, force_refresh: forceRefresh,
      });
      if (result.errcode && Number(result.errcode) !== 0) {
        const message = Number(result.errcode) === 40164 ? '微信服务端 IP 未加入白名单，请联系管理员配置。' : '无法取得微信接口凭据，请联系管理员检查 AppID、AppSecret 与接口权限。';
        throw failure(message, 503);
      }
      if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw failure('微信接口凭据返回异常，请稍后重试。', 502);
      cached = { value: result.access_token, expiresAt: new Date(clock()).getTime() + Math.max(0, result.expires_in - 60) * 1000 };
      return cached.value;
    })();
    try { return await pending; } finally { pending = undefined; }
  }
  return async function exchange(code) {
    if (!appId || !appSecret) throw failure('微信手机号登录尚未配置，请联系管理员填写 .env。', 503);
    if (typeof code !== 'string' || !code.trim() || code.length > 1024) throw failure('请重新获取微信手机号授权。', 400);
    let token = await accessToken();
    const phoneRequest = value => post(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(value)}`, { code });
    let result = await phoneRequest(token);
    // A definitive token rejection has not consumed the phone code. Never retry
    // a timeout or an ambiguous network failure, which may have consumed it.
    if (TOKEN_INVALID.has(Number(result.errcode))) {
      if (cached?.value === token) cached = undefined;
      token = cached?.value || await accessToken(true);
      result = await phoneRequest(token);
    }
    if (TOKEN_INVALID.has(Number(result.errcode))) throw failure('微信接口凭据暂时不可用，请稍后重新授权。', 503);
    if (result.errcode && Number(result.errcode) !== 0) throw phoneFailure(result.errcode);
    return result;
  };
}
