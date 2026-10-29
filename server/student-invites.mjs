import { createHash, randomInt, randomUUID } from 'node:crypto';

export const STUDENT_INVITE_LIFETIME_MS = 7 * 86400000;
export const STUDENT_INVITE_ERROR = '邀请码无效、已失效或暂不可使用，请核对后重试或联系管理员。';
const digest = value => createHash('sha256').update(value).digest('hex');
export function generateStudentInvite(random = randomInt) { return String(random(0, 100000000)).padStart(8, '0'); }
export function studentInviteHash(code) { return digest(`lianduoduo:student-invite:v1:${code}`); }
export function studentMemberIds(row) {
  const ids = [row.member_id];
  if (row.member_ids) { const value = JSON.parse(row.member_ids);if (Array.isArray(value)) ids.push(...value.filter(id => typeof id === 'string')); }
  return [...new Set(ids.filter(id => typeof id === 'string' && id))];
}
/** Include inactive legacy family grants: an existing WeChat owner is never transferable. */
export async function studentGrantState(database, member, userId) {
  const rows = (await database.prepare("SELECT * FROM memberships WHERE role='student' ORDER BY seq").all()).filter(row => studentMemberIds(row).includes(member.id));
  const link = await database.prepare('SELECT * FROM wechat_member_links WHERE member_id=?').get(member.id), owners = new Set(link ? [link.user_id] : []);
  let existingPasswordAccess = false;
  const users = new Map();
  for (const row of rows) {
    if (!users.has(row.user_id)) {
      const binding = await database.prepare('SELECT user_id,created_at FROM wechat_bindings WHERE user_id=?').get(row.user_id), user = await database.prepare('SELECT status,password_hash FROM users WHERE id=?').get(row.user_id);
      users.set(row.user_id, { binding, user });
    }
    const { binding, user } = users.get(row.user_id);
    if (binding) owners.add(row.user_id);
    if (row.status === 'active' && user?.status === 'active' && user.password_hash !== '!wechat-only') existingPasswordAccess = true;
  }
  return { rows, link, owners, existingPasswordAccess,
    otherWechatOwner: [...owners].some(owner => owner !== userId),
    activeOwn: rows.find(row => row.user_id === userId && row.tenant_id === member.tenantId && row.status === 'active'),
    disabledOwn: !!userId && rows.some(row => row.user_id === userId && row.status !== 'active'),
  };
}

/** The caller holds the shared database revision lock for each operation. */
export function createStudentInviteService({ database, clock = () => new Date(), generateCode = generateStudentInvite }) {
  async function status(memberId) {
    const row = await database.prepare('SELECT expires_at,claimed_at FROM member_wechat_invites WHERE member_id=?').get(memberId);
    return { memberId, status: !row ? 'not_generated' : row.claimed_at ? 'claimed' : row.expires_at > clock().toISOString() ? 'active' : 'expired', expiresAt: row?.expires_at ?? null, ...(row?.claimed_at ? { claimedAt: row.claimed_at } : {}) };
  }
  async function reset({ member, userId }) {
    const previous = await database.prepare('SELECT code_hash FROM member_wechat_invites WHERE member_id=?').get(member.id);
    for (let attempt = 0; attempt < 100; attempt++) {
      const inviteCode = generateCode();if (typeof inviteCode !== 'string' || !/^\d{8}$/.test(inviteCode)) throw new Error('Invalid student-invite generator');
      const codeHash = studentInviteHash(inviteCode);
      if (codeHash === previous?.code_hash || await database.prepare('SELECT member_id FROM member_wechat_invites WHERE code_hash=?').get(codeHash)) continue;
      const now = clock(), stamp = now.toISOString(), expiresAt = new Date(now.getTime() + STUDENT_INVITE_LIFETIME_MS).toISOString();
      await database.prepare('INSERT INTO member_wechat_invites(member_id,tenant_id,store_id,code_hash,generation,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE tenant_id=VALUES(tenant_id),store_id=VALUES(store_id),code_hash=VALUES(code_hash),generation=VALUES(generation),created_by=VALUES(created_by),created_at=VALUES(created_at),expires_at=VALUES(expires_at),claimed_at=NULL,claimed_user_id=NULL').run(member.id, member.tenantId, member.storeId, codeHash, randomUUID(), userId, stamp, expiresAt);
      return { memberId: member.id, status: 'active', expiresAt, inviteCode };
    }
    throw Object.assign(new Error('暂时无法生成新的学员邀请码，请稍后重试。'), { status: 503 });
  }
  async function find(code) { return database.prepare('SELECT * FROM member_wechat_invites WHERE code_hash=? AND expires_at>? AND claimed_at IS NULL').get(studentInviteHash(code), clock().toISOString()); }
  async function attempt({ openidHash, ip }) {
    const stamp = clock().toISOString(), until = new Date(clock().getTime() + 15 * 60000).toISOString();
    await database.prepare('DELETE FROM wechat_student_attempts WHERE resets_at<=?').run(stamp);
    const keys = [[digest(`principal:${openidHash}`), 10], [digest(`ip:${ip}`), 30]];
    for (const [key, limit] of keys) { const row = await database.prepare('SELECT attempts FROM wechat_student_attempts WHERE attempt_hash=?').get(key);if (row && row.attempts >= limit) return false; }
    for (const [key] of keys) await database.prepare('INSERT INTO wechat_student_attempts(attempt_hash,attempts,resets_at) VALUES(?,1,?) ON DUPLICATE KEY UPDATE attempts=attempts+1').run(key, until);
    return true;
  }
  return { status, reset, find, attempt };
}
