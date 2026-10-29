import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash, scryptSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMysqlFixture } from './mysql.helpers.mjs';
import { LEGACY_BUSINESS_TABLES as BUSINESS_TABLES, createMySQLDatabase } from '../server/database.mjs';
import { createLocalServer } from '../server/app.mjs';
import { migrateSQLiteToMySQL } from '../local/migrate-mysql.mjs';

const stamp = '2026-10-28T02:00:00.000Z';
const sha = value => createHash('sha256').update(value).digest('hex');
const attachments = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAt0AAAAASUVORK5CYII=', 'base64');
const authTables = ['users', 'memberships', 'sessions', 'wechat_bindings', 'wechat_codes', 'wechat_onboarding', 'receipt_attachments'];

function sourceFixture({ legacySession = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lianduoduo-mysql-migration-'));
  const sourcePath = join(directory, 'source.sqlite');
  const source = new DatabaseSync(sourcePath);
  source.exec('PRAGMA foreign_keys=ON;');
  for (const table of BUSINESS_TABLES) source.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,tenant_id TEXT,store_id TEXT,data TEXT NOT NULL CHECK(json_valid(data)))`);
  source.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY,account TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,password_hash TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE memberships(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,tenant_id TEXT REFERENCES tenants(id),store_id TEXT REFERENCES stores(id),coach_id TEXT REFERENCES coaches(id),member_id TEXT REFERENCES members(id),member_ids TEXT,label TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),membership_id TEXT NOT NULL REFERENCES memberships(id),created_at TEXT NOT NULL,expires_at TEXT NOT NULL${legacySession ? '' : ',login_method TEXT NOT NULL'});
    CREATE TABLE wechat_bindings(openid_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id),created_at TEXT NOT NULL);
    CREATE TABLE wechat_codes(code_hash TEXT PRIMARY KEY,expires_at TEXT NOT NULL);
    CREATE TABLE wechat_onboarding(ticket_hash TEXT PRIMARY KEY,openid_hash TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT);
    CREATE TABLE receipt_attachments(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),store_id TEXT NOT NULL,member_id TEXT NOT NULL REFERENCES members(id),uploader_id TEXT NOT NULL REFERENCES users(id),order_id TEXT REFERENCES orders(id),name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,content BLOB NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE old_empty_helper(value TEXT);
  `);
  const ids = Object.fromEntries(BUSINESS_TABLES.map(table => [table, `old-${table}`]));
  for (const table of BUSINESS_TABLES) {
    // Whitespace and emoji deliberately remain in the stored JSON string.
    const data = ' {"id":' + JSON.stringify(ids[table]) + ',"name":"迁移资料 🏋️","mode":"solo","amount":10001,"tenantId":' + JSON.stringify(ids.tenants) + '}\n';
    source.prepare(`INSERT INTO ${table}(rowid,id,tenant_id,store_id,data) VALUES(?,?,?,?,?)`).run(9, ids[table], table === 'tenants' ? null : ids.tenants, table === 'tenants' ? null : '', data);
  }
  source.prepare('INSERT INTO members(rowid,id,tenant_id,store_id,data) VALUES(?,?,?,?,?)').run(21, 'another-member', ids.tenants, '', '{"id":"another-member","name":"另一学员"}');
  source.prepare('INSERT INTO meta VALUES(?,?)').run('version', '7');
  source.prepare('INSERT INTO meta VALUES(?,?)').run('createdAt', stamp);
  const salt = 'migration-fixture-salt';
  const passwordHash = `${salt}:${scryptSync('Migration-Fixture-Password!', salt, 64).toString('hex')}`;
  source.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run('old-password-user', 'migration_owner', '原有账密用户', passwordHash, 'active', stamp);
  source.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run('old-wechat-user', 'wx_migration_user', '原有微信教练', '!wechat-only', 'active', stamp);
  source.prepare('INSERT INTO memberships(rowid,id,user_id,role,tenant_id,store_id,coach_id,member_id,member_ids,label,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(7, 'old-password-membership', 'old-password-user', 'hq', ids.tenants, null, ids.coaches, null, null, '原有总部', 'active');
  source.prepare('INSERT INTO memberships(rowid,id,user_id,role,tenant_id,store_id,coach_id,member_id,member_ids,label,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(13, 'old-wechat-membership', 'old-wechat-user', 'hq', ids.tenants, null, ids.coaches, null, JSON.stringify([ids.members, 'another-member']), '原有独立教练', 'active');
  const token = 'migration-fixture-existing-session';
  const session = [sha(token), 'old-wechat-user', 'old-wechat-membership', stamp, '2099-12-31T23:59:59.999Z', ...(legacySession ? [] : ['wechat'])];
  source.prepare(`INSERT INTO sessions VALUES(${session.map(() => '?').join(',')})`).run(...session);
  source.prepare('INSERT INTO wechat_bindings VALUES(?,?,?)').run(sha('original-openid'), 'old-wechat-user', stamp);
  source.prepare('INSERT INTO wechat_codes VALUES(?,?)').run(sha('original-code'), '2099-12-31T23:59:59.999Z');
  source.prepare('INSERT INTO wechat_onboarding VALUES(?,?,?,?,?)').run(sha('original-ticket'), sha('pending-openid'), stamp, '2099-12-31T23:59:59.999Z', null);
  for (const [id, orderId] of [['receipt-old-linked', ids.orders], ['receipt-old-draft', null]]) source.prepare('INSERT INTO receipt_attachments VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, ids.tenants, '', ids.members, 'old-wechat-user', orderId, '原始收款凭证.png', 'image/png', attachments.length, attachments, stamp);
  const expected = {};
  for (const table of [...BUSINESS_TABLES, 'meta', ...authTables]) {
    const hasSequence = BUSINESS_TABLES.includes(table) || table === 'memberships';
    expected[table] = source.prepare(`SELECT ${hasSequence ? 'rowid AS seq,' : ''}* FROM ${table}`).all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, ArrayBuffer.isView(value) ? Buffer.from(value) : value])));
    if (table === 'sessions' && legacySession) expected[table].forEach(row => { row.login_method = 'password'; });
  }
  source.close();
  return { sourcePath, ids, token, expected, passwordHash, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

async function withTarget(run) {
  const fixture = await createMysqlFixture();
  let database;
  try { database = await createMySQLDatabase(fixture.options); return await run(database); }
  finally { if (database) await database.close(); await fixture.dispose(); }
}
async function assertEmpty(database) {
  for (const table of [...BUSINESS_TABLES, ...authTables, 'data_migrations']) assert.equal((await database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n, 0, table);
  assert.deepEqual(await database.prepare('SELECT `key`,value FROM meta').all(), [{ key: 'version', value: '0' }]);
}
function primaryKey(table) { return ({ meta: 'key', sessions: 'token_hash', wechat_bindings: 'openid_hash', wechat_codes: 'code_hash', wechat_onboarding: 'ticket_hash' })[table] || 'id'; }

// Test-created sources and generated MySQL schemas are disposable and never use the user's database.
test('SQLite迁移MySQL逐字段保留账号、会话、顺序、JSON与已关联BLOB，重复执行不覆盖新写入', async () => {
  const source = sourceFixture();
  try {
    const sourceDigest = sha(readFileSync(source.sourcePath));
    await withTarget(async database => {
      const report = await migrateSQLiteToMySQL({ sourcePath: source.sourcePath, database });
      assert.equal(report.status, 'imported');assert.deepEqual(report.ignoredEmptyTables, ['old_empty_helper']);
      for (const [table, rows] of Object.entries(source.expected)) {
        const columns = Object.keys(rows[0]);
        const actual = await database.prepare(`SELECT ${columns.map(name => '`' + name + '`').join(',')} FROM ${table}`).all();
        const key = primaryKey(table);actual.sort((a, b) => a[key].localeCompare(b[key]));rows.sort((a, b) => a[key].localeCompare(b[key]));
        assert.deepEqual(actual, rows, table);assert.equal(report.counts[table], rows.length);
      }
      assert.equal((await database.prepare('SELECT password_hash FROM users WHERE id=?').get('old-password-user')).password_hash, source.passwordHash);
      assert.deepEqual((await database.prepare('SELECT content FROM receipt_attachments WHERE id=?').get('receipt-old-linked')).content, attachments);
      assert.deepEqual((await database.prepare('SELECT seq FROM members ORDER BY seq').all()).map(row => row.seq), [9, 21]);
      const server = await createLocalServer({ database });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/session`, { headers: { Authorization: `Bearer ${source.token}` } });
        assert.equal(response.status, 200);const session = await response.json();assert.equal(session.user.id, 'old-wechat-user');assert.equal(session.loginMethod, 'wechat');assert.equal(session.activeMembership.id, 'old-wechat-membership');
      } finally { await new Promise(resolve => server.close(resolve)); }
      await database.prepare('UPDATE members SET data=? WHERE id=?').run('{"id":"another-member","name":"迁移后修改"}', 'another-member');
      await database.prepare("UPDATE meta SET value='8' WHERE `key`='version'").run();
      const again = await migrateSQLiteToMySQL({ sourcePath: source.sourcePath, database });assert.equal(again.status, 'already-imported');assert.equal(again.sourceDigest, report.sourceDigest);
      assert.equal((await database.prepare('SELECT data FROM members WHERE id=?').get('another-member')).data, '{"id":"another-member","name":"迁移后修改"}');
      assert.equal((await database.prepare("SELECT value FROM meta WHERE `key`='version'").get()).value, '8');
      assert.equal(sha(readFileSync(source.sourcePath)), sourceDigest);
      const writer = new DatabaseSync(source.sourcePath);writer.prepare('UPDATE users SET name=? WHERE id=?').run('另一份源库', 'old-password-user');writer.close();
      await assert.rejects(() => migrateSQLiteToMySQL({ sourcePath: source.sourcePath, database }), /另一份|禁止覆盖/);
      assert.equal((await database.prepare('SELECT name FROM users WHERE id=?').get('old-password-user')).name, '原有账密用户');
    });
  } finally { source.dispose(); }
});

test('迁移拒绝非空MySQL目标，不覆盖原记录或生成半批标记', async () => {
  const source = sourceFixture();
  try {
    await withTarget(async database => {
      await database.prepare('INSERT INTO users(id,account,name,password_hash,status,created_at) VALUES(?,?,?,?,?,?)').run('existing-target-user', 'existing_target', '目标现有用户', '!wechat-only', 'active', stamp);
      await assert.rejects(() => migrateSQLiteToMySQL({ sourcePath: source.sourcePath, database }), /已有数据|禁止覆盖/);
      assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM users').get()).n, 1);assert.equal((await database.prepare('SELECT name FROM users').get()).name, '目标现有用户');
      assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM tenants').get()).n, 0);assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM data_migrations').get()).n, 0);
    });
  } finally { source.dispose(); }
});

test('迁移拒绝未映射的非空源表，保留源文件且目标仍为空', async () => {
  const source = sourceFixture();
  try {
    const writer = new DatabaseSync(source.sourcePath);writer.exec("CREATE TABLE unmapped_records(id TEXT PRIMARY KEY,note TEXT); INSERT INTO unmapped_records VALUES('unknown','不得丢失');");writer.close();
    const digest = sha(readFileSync(source.sourcePath));
    await withTarget(async database => { await assert.rejects(() => migrateSQLiteToMySQL({ sourcePath: source.sourcePath, database }), /未映射|尚未映射/);await assertEmpty(database); });
    assert.equal(sha(readFileSync(source.sourcePath)), digest);
  } finally { source.dispose(); }
});

test('迁移后置BLOB写入失败会回滚全部业务和认证记录，修正后可完整重试', async () => {
  const source = sourceFixture();
  try {
    await withTarget(async database => {
      await database.exec("CREATE TRIGGER fail_migration_attachment BEFORE INSERT ON receipt_attachments FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional migration rollback'");
      await assert.rejects(() => migrateSQLiteToMySQL({ sourcePath: source.sourcePath, database }), /intentional migration rollback/);await assertEmpty(database);
      await database.exec('DROP TRIGGER fail_migration_attachment');
      assert.equal((await migrateSQLiteToMySQL({ sourcePath: source.sourcePath, database })).status, 'imported');assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM users').get()).n, 2);
      assert.deepEqual((await database.prepare('SELECT content FROM receipt_attachments WHERE id=?').get('receipt-old-linked')).content, attachments);
    });
  } finally { source.dispose(); }
});

test('旧版会话缺少login_method时迁移为password，不丢会话hash与有效期', async () => {
  const source = sourceFixture({ legacySession: true });
  try {
    await withTarget(async database => {
      await migrateSQLiteToMySQL({ sourcePath: source.sourcePath, database });
      assert.deepEqual(await database.prepare('SELECT token_hash,user_id,membership_id,created_at,expires_at,login_method FROM sessions').all(), source.expected.sessions);
    });
  } finally { source.dispose(); }
});
