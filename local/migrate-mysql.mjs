import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Keep the historical import digest stable when new MySQL-only features add tables.
import { LEGACY_BUSINESS_TABLES as BUSINESS_TABLES, createMySQLDatabase } from '../server/database.mjs';
import { loadLocalEnvironment, projectRoot } from './env.mjs';

const MIGRATION = 'sqlite_import_v1';
const businessColumns = ['id', 'tenant_id', 'store_id', 'data', 'seq'];
const COLUMNS = Object.fromEntries(BUSINESS_TABLES.map(table => [table, businessColumns]));
Object.assign(COLUMNS, {
  meta: ['key', 'value'],
  users: ['id', 'account', 'name', 'password_hash', 'status', 'created_at'],
  memberships: ['id', 'user_id', 'role', 'tenant_id', 'store_id', 'coach_id', 'member_id', 'member_ids', 'label', 'status', 'seq'],
  sessions: ['token_hash', 'user_id', 'membership_id', 'created_at', 'expires_at', 'login_method'],
  wechat_bindings: ['openid_hash', 'user_id', 'created_at'],
  wechat_codes: ['code_hash', 'expires_at'],
  wechat_onboarding: ['ticket_hash', 'openid_hash', 'created_at', 'expires_at', 'used_at'],
  receipt_attachments: ['id', 'tenant_id', 'store_id', 'member_id', 'uploader_id', 'order_id', 'name', 'mime', 'size', 'content', 'created_at'],
});
const IMPORT_ORDER = [...BUSINESS_TABLES, 'users', 'memberships', 'sessions', 'wechat_bindings', 'wechat_codes', 'wechat_onboarding', 'receipt_attachments', 'meta'];
const PRIMARY_KEY = { meta: 'key', sessions: 'token_hash', wechat_bindings: 'openid_hash', wechat_codes: 'code_hash', wechat_onboarding: 'ticket_hash' };
function sqliteQuote(value) { return `"${value.replaceAll('"', '""')}"`; }
function mysqlQuote(value) { return `\`${value.replaceAll('`', '``')}\``; }
function normalized(value) { return ArrayBuffer.isView(value) ? { bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') } : value; }
function encodedRow(table, row) { return JSON.stringify(COLUMNS[table].map(column => normalized(row[column] ?? null))); }
function rowDigest(table, row) { return createHash('sha256').update(encodedRow(table, row)).digest('hex'); }

function readSnapshot(sourcePath) {
  const source = new DatabaseSync(resolve(sourcePath), { readOnly: true });
  try {
    source.exec('BEGIN');
    if (source.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite 源库完整性检查失败，未迁移数据。');
    if (source.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite 源库存在外键错误，未迁移数据。');
    const present = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    const ignoredEmptyTables = [];
    for (const table of present.filter(name => !Object.hasOwn(COLUMNS, name))) {
      const count = source.prepare(`SELECT COUNT(*) AS n FROM ${sqliteQuote(table)}`).get().n;
      if (count) throw new Error(`SQLite 存在尚未映射的非空表 ${table}，为避免遗漏数据已停止迁移。`);
      ignoredEmptyTables.push(table);
    }
    for (const table of ['meta', 'users', 'memberships', ...BUSINESS_TABLES]) if (!present.includes(table)) throw new Error(`SQLite 缺少必需表 ${table}，未迁移数据。`);
    const tables = {};
    for (const table of IMPORT_ORDER) {
      if (!present.includes(table)) { tables[table] = []; continue; }
      const available = new Set(source.prepare(`PRAGMA table_info(${sqliteQuote(table)})`).all().map(column => column.name));
      const columns = COLUMNS[table].map(column => {
        if (column === 'seq') return 'rowid AS seq';
        if (table === 'sessions' && column === 'login_method' && !available.has(column)) return "'password' AS login_method";
        if (!available.has(column)) throw new Error(`SQLite 表 ${table} 缺少字段 ${column}，未迁移数据。`);
        return sqliteQuote(column);
      });
      const order = COLUMNS[table].includes('seq') ? 'rowid' : sqliteQuote(PRIMARY_KEY[table] ?? 'id');
      tables[table] = source.prepare(`SELECT ${columns.join(',')} FROM ${sqliteQuote(table)} ORDER BY ${order}`).all();
    }
    const version = tables.meta.find(row => row.key === 'version')?.value;
    if (version === undefined || !Number.isSafeInteger(Number(version)) || Number(version) < 0) throw new Error('SQLite 缺少有效业务版本，未迁移数据。');
    const digest = createHash('sha256');
    for (const table of IMPORT_ORDER) {
      digest.update(table + '\n');
      for (const row of tables[table]) digest.update(encodedRow(table, row) + '\n');
    }
    digest.update(JSON.stringify(ignoredEmptyTables.sort()));
    return { tables, digest: digest.digest('hex'), ignoredEmptyTables, counts: Object.fromEntries(IMPORT_ORDER.map(table => [table, tables[table].length])) };
  } finally {
    if (source.isTransaction) source.exec('ROLLBACK');
    source.close();
  }
}

/** A one-time, transactional import. Runtime storage never reads this SQLite source. */
export async function migrateSQLiteToMySQL({ sourcePath, database }) {
  if (!sourcePath || !database || database.storageEngine !== 'mysql') throw new Error('迁移必须指定只读 SQLite 源路径和 MySQL 目标连接。');
  const snapshot = readSnapshot(sourcePath);
  return database.transaction(async () => {
    const previous = await database.prepare('SELECT source_digest,row_counts FROM data_migrations WHERE id=?').get(MIGRATION);
    if (previous) {
      if (previous.source_digest !== snapshot.digest) throw new Error('目标库已执行过另一份 SQLite 导入；禁止覆盖现有数据。');
      // Subsequent application writes are legitimate; never overwrite or replay the import.
      return { status: 'already-imported', sourceDigest: snapshot.digest, counts: JSON.parse(previous.row_counts), ignoredEmptyTables: snapshot.ignoredEmptyTables };
    }
    if (Number((await database.prepare('SELECT COUNT(*) AS n FROM schedule_plans').get()).n)) throw new Error('MySQL 目标已有排课计划，禁止覆盖；请使用空目标库。');
    if (Number((await database.prepare('SELECT COUNT(*) AS n FROM venues').get()).n)) throw new Error('MySQL 目标已有场地，禁止覆盖；请使用空目标库。');
    if (Number((await database.prepare('SELECT COUNT(*) AS n FROM coach_bills').get()).n)) throw new Error('MySQL 目标已有教练账单，禁止覆盖；请使用空目标库。');
    for (const table of IMPORT_ORDER.filter(name => name !== 'meta')) {
      const { n } = await database.prepare(`SELECT COUNT(*) AS n FROM ${mysqlQuote(table)}`).get();
      if (Number(n)) throw new Error(`MySQL 目标表 ${table} 已有数据，禁止覆盖；请使用空目标库。`);
    }
    const meta = await database.prepare('SELECT `key`,value FROM meta').all();
    if (meta.some(row => row.key !== 'version' || row.value !== '0')) throw new Error('MySQL 已有业务版本或元数据，禁止覆盖。');
    for (const table of IMPORT_ORDER) {
      const columns = COLUMNS[table];
      const statement = table === 'meta'
        ? `INSERT INTO meta (${columns.map(mysqlQuote).join(',')}) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)`
        : `INSERT INTO ${mysqlQuote(table)} (${columns.map(mysqlQuote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
      for (const row of snapshot.tables[table]) {
        const values = columns.map(column => ArrayBuffer.isView(row[column]) ? Buffer.from(row[column].buffer, row[column].byteOffset, row[column].byteLength) : row[column] ?? null);
        await database.prepare(statement).run(...values);
      }
    }
    // Verify every selected scalar and BLOB byte before committing, including sequence order.
    for (const table of IMPORT_ORDER) {
      const columns = COLUMNS[table];
      const key = PRIMARY_KEY[table] ?? 'id';
      const rows = await database.prepare(`SELECT ${columns.map(mysqlQuote).join(',')} FROM ${mysqlQuote(table)}`).all();
      const expected = new Map(snapshot.tables[table].map(row => [row[key], rowDigest(table, row)]));
      if (rows.length !== expected.size || rows.some(row => rowDigest(table, row) !== expected.get(row[key]))) throw new Error(`MySQL ${table} 导入逐字段校验失败，整批数据已回滚。`);
    }
    await database.prepare('INSERT INTO data_migrations(id,source_digest,imported_at,row_counts) VALUES(?,?,?,?)').run(MIGRATION, snapshot.digest, new Date().toISOString(), JSON.stringify(snapshot.counts));
    return { status: 'imported', sourceDigest: snapshot.digest, counts: snapshot.counts, ignoredEmptyTables: snapshot.ignoredEmptyTables };
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--source' || !args[1]) throw new Error('用法：node local/migrate-mysql.mjs --source ./data/lianduoduo.sqlite');
  loadLocalEnvironment();
  const database = await createMySQLDatabase();
  try {
    const report = await migrateSQLiteToMySQL({ sourcePath: resolve(projectRoot, args[1]), database });
    console.log(JSON.stringify({ storageEngine: 'mysql', ...report, sourcePreserved: true }, null, 2));
  } finally { await database.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(`MySQL 迁移失败：${error.message}`); process.exitCode = 1; });
}
