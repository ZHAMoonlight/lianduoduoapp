import { createHash, randomInt, randomUUID } from 'node:crypto';

const DAY = 86400000;
export const TEAM_CODE_LIFETIME_MS = 7 * DAY;
export const TEAM_MATCH_ERROR = '手机号或团队码不匹配、已失效或暂不可加入，请核对后重试或联系门店管理员。';
export function generateTeamCode(random = randomInt) { return String(random(0, 1000000)).padStart(6, '0'); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export function teamCodeHash(code) { return digest(`lianduoduo:store-team-code:v1:${code}`); }

/** All methods run under the caller's database revision lock. No plaintext codes persist. */
export function createTeamCodeService({ database, clock = () => new Date(), generateCode = generateTeamCode }) {
  async function status(storeId) {
    const row = await database.prepare('SELECT expires_at FROM store_team_codes WHERE store_id=?').get(storeId);
    return { storeId, status: !row ? 'not_generated' : row.expires_at > clock().toISOString() ? 'active' : 'expired', expiresAt: row?.expires_at ?? null };
  }
  async function reset({ tenantId, storeId, userId }) {
    const previous = await database.prepare('SELECT code_hash FROM store_team_codes WHERE store_id=?').get(storeId);
    for (let attempt = 0; attempt < 100; attempt++) {
      const teamCode = generateCode();
      if (typeof teamCode !== 'string' || !/^\d{6}$/.test(teamCode)) throw new Error('Invalid team-code generator');
      const codeHash = teamCodeHash(teamCode);
      // Never reuse the previous code on reset, including a coincidental random collision.
      if (codeHash === previous?.code_hash || await database.prepare('SELECT store_id FROM store_team_codes WHERE code_hash=?').get(codeHash)) continue;
      const now = clock(), stamp = now.toISOString(), expiresAt = new Date(now.getTime() + TEAM_CODE_LIFETIME_MS).toISOString(), generation = randomUUID();
      await database.prepare('INSERT INTO store_team_codes(store_id,tenant_id,code_hash,generation,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE tenant_id=VALUES(tenant_id),code_hash=VALUES(code_hash),generation=VALUES(generation),created_by=VALUES(created_by),created_at=VALUES(created_at),expires_at=VALUES(expires_at)').run(storeId, tenantId, codeHash, generation, userId, stamp, expiresAt);
      return { storeId, status: 'active', expiresAt, teamCode };
    }
    throw Object.assign(new Error('暂时无法生成新的团队码，请稍后重试。'), { status: 503 });
  }
  async function find(teamCode) { return database.prepare('SELECT * FROM store_team_codes WHERE code_hash=? AND expires_at>?').get(teamCodeHash(teamCode), clock().toISOString()); }
  async function currentClaim(claim) {
    return database.prepare('SELECT store_id FROM store_team_codes WHERE store_id=? AND tenant_id=? AND generation=? AND expires_at>?').get(claim.team_store_id, claim.team_tenant_id, claim.team_generation, clock().toISOString());
  }
  // Return a decision rather than throwing: the rate-limit transaction must commit
  // even when the subsequent match fails or the caller returns HTTP 429.
  async function attempt({ openidHash, ip }) {
    const now = clock(), stamp = now.toISOString(), until = new Date(now.getTime() + 15 * 60000).toISOString();
    await database.prepare('DELETE FROM wechat_team_attempts WHERE resets_at<=?').run(stamp);
    const keys = [[digest(`principal:${openidHash}`), 10], [digest(`ip:${ip}`), 30]];
    for (const [key, limit] of keys) {
      const row = await database.prepare('SELECT attempts FROM wechat_team_attempts WHERE attempt_hash=?').get(key);
      if (row && row.attempts >= limit) return false;
    }
    for (const [key] of keys) await database.prepare('INSERT INTO wechat_team_attempts(attempt_hash,attempts,resets_at) VALUES(?,1,?) ON DUPLICATE KEY UPDATE attempts=attempts+1').run(key, until);
    return true;
  }
  return { status, reset, find, currentClaim, attempt };
}
