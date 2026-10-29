import mysql from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export const LEGACY_BUSINESS_TABLES = ['tenants', 'stores', 'coaches', 'members', 'cards', 'classes', 'bookings', 'settlements', 'tasks', 'audit', 'announcements', 'applications', 'orders', 'ledger', 'followups', 'feedback'];
export const BUSINESS_TABLES = [...LEGACY_BUSINESS_TABLES, 'schedule_plans', 'venues', 'coach_bills'];
const APPEND_ONLY = ['ledger', 'audit', 'feedback'];
const ID = 'VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin';
const STAMP = 'VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin';
const ENGINE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';

export function mysqlOptions(options = {}) {
  const configuration = {
    host: options.host ?? process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(options.port ?? process.env.MYSQL_PORT ?? 3306),
    user: options.user ?? process.env.MYSQL_USER,
    password: options.password ?? process.env.MYSQL_PASSWORD ?? '',
    database: options.database ?? process.env.MYSQL_DATABASE,
    connectionLimit: Number(options.connectionLimit ?? process.env.MYSQL_CONNECTION_LIMIT ?? 10),
  };
  if (!configuration.user || !configuration.database || !/^[A-Za-z0-9_]{1,64}$/.test(configuration.database)) throw new Error('请在 .env 配置有效的 MYSQL_USER 和 MYSQL_DATABASE。');
  if (!Number.isInteger(configuration.port) || configuration.port < 1 || configuration.port > 65535) throw new Error('MYSQL_PORT 必须是有效端口。');
  if (!Number.isInteger(configuration.connectionLimit) || configuration.connectionLimit < 1 || configuration.connectionLimit > 100) throw new Error('MYSQL_CONNECTION_LIMIT 必须为 1–100。');
  return configuration;
}

async function initializeSchema(connection, databaseName) {
  // A database-scoped advisory lock also protects first boot by concurrent processes.
  const lockName = `lianduoduo_schema_${createHash('sha256').update(databaseName).digest('hex').slice(0, 40)}`;
  const [locks] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
  if (Number(locks[0].acquired) !== 1) throw new Error('无法取得 MySQL 初始化锁，请稍后重试。');
  try {
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version INT NOT NULL PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ${ENGINE}`);
    const [installed] = await connection.query('SELECT version FROM schema_migrations WHERE version=1');
    if (!installed.length) {
    for (const table of BUSINESS_TABLES) {
      await connection.query(`CREATE TABLE IF NOT EXISTS \`${table}\` (id ${ID} NOT NULL PRIMARY KEY, tenant_id ${ID}, store_id ${ID}, data LONGTEXT NOT NULL, seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, UNIQUE KEY ${table}_seq (seq), KEY ${table}_tenant (tenant_id,store_id), CONSTRAINT ${table}_data_json CHECK (JSON_VALID(data))) ${ENGINE}`);
    }
    const ddl = [
      `CREATE TABLE IF NOT EXISTS meta (\`key\` VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, value LONGTEXT NOT NULL) ${ENGINE}`,
      `CREATE TABLE IF NOT EXISTS users (id ${ID} NOT NULL PRIMARY KEY, account VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL UNIQUE, name VARCHAR(200) NOT NULL, password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active', created_at ${STAMP} NOT NULL) ${ENGINE}`,
      `CREATE TABLE IF NOT EXISTS memberships (id ${ID} NOT NULL PRIMARY KEY, user_id ${ID} NOT NULL, role VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, tenant_id ${ID}, store_id ${ID}, coach_id ${ID}, member_id ${ID}, member_ids LONGTEXT, label TEXT NOT NULL, status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active', seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, tenant_key ${ID} GENERATED ALWAYS AS (COALESCE(tenant_id,'')) STORED, store_key ${ID} GENERATED ALWAYS AS (COALESCE(store_id,'')) STORED, coach_key ${ID} GENERATED ALWAYS AS (COALESCE(coach_id,'')) STORED, member_key ${ID} GENERATED ALWAYS AS (COALESCE(member_id,'')) STORED, UNIQUE KEY membership_seq(seq), UNIQUE KEY membership_unique(user_id,role,tenant_key,store_key,coach_key,member_key), FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(tenant_id) REFERENCES tenants(id), FOREIGN KEY(store_id) REFERENCES stores(id), FOREIGN KEY(coach_id) REFERENCES coaches(id), FOREIGN KEY(member_id) REFERENCES members(id), CONSTRAINT membership_role CHECK(role IN ('platform','hq','manager','coach','student')), CONSTRAINT membership_ids_json CHECK(member_ids IS NULL OR JSON_VALID(member_ids))) ${ENGINE}`,
      `CREATE TABLE IF NOT EXISTS sessions (token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, user_id ${ID} NOT NULL, membership_id ${ID} NOT NULL, created_at ${STAMP} NOT NULL, expires_at ${STAMP} NOT NULL, login_method VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'password', FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(membership_id) REFERENCES memberships(id), KEY session_expiry(expires_at)) ${ENGINE}`,
      `CREATE TABLE IF NOT EXISTS wechat_bindings (openid_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, user_id ${ID} NOT NULL UNIQUE, created_at ${STAMP} NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id)) ${ENGINE}`,
      `CREATE TABLE IF NOT EXISTS wechat_codes (code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, expires_at ${STAMP} NOT NULL, KEY code_expiry(expires_at)) ${ENGINE}`,
      `CREATE TABLE IF NOT EXISTS wechat_onboarding (ticket_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, openid_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, created_at ${STAMP} NOT NULL, expires_at ${STAMP} NOT NULL, used_at ${STAMP}, KEY wechat_onboarding_openid(openid_hash), KEY onboarding_expiry(expires_at)) ${ENGINE}`,
      `CREATE TABLE IF NOT EXISTS receipt_attachments (id ${ID} NOT NULL PRIMARY KEY, tenant_id ${ID} NOT NULL, store_id ${ID} NOT NULL, member_id ${ID} NOT NULL, uploader_id ${ID} NOT NULL, order_id ${ID}, name VARCHAR(180) NOT NULL, mime VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, size INT UNSIGNED NOT NULL, content LONGBLOB NOT NULL, created_at ${STAMP} NOT NULL, FOREIGN KEY(tenant_id) REFERENCES tenants(id), FOREIGN KEY(member_id) REFERENCES members(id), FOREIGN KEY(uploader_id) REFERENCES users(id), FOREIGN KEY(order_id) REFERENCES orders(id), KEY receipt_attachments_order(order_id), CONSTRAINT receipt_size CHECK(size>0 AND size<=10485760), CONSTRAINT receipt_content_size CHECK(OCTET_LENGTH(content)=size)) ${ENGINE}`,
      `CREATE TABLE IF NOT EXISTS data_migrations (id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, source_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, imported_at ${STAMP} NOT NULL, row_counts LONGTEXT NOT NULL, CONSTRAINT migration_counts_json CHECK(JSON_VALID(row_counts))) ${ENGINE}`,
    ];
    for (const statement of ddl) await connection.query(statement);
    await connection.query("INSERT IGNORE INTO meta (`key`,value) VALUES('version','0')");
    const triggers = [];
    for (const table of APPEND_ONLY) {
      for (const action of ['UPDATE', 'DELETE']) triggers.push({ name: `${table}_no_${action.toLowerCase()}`, sql: `CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON \`${table}\` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='append-only record'` });
    }
    triggers.push({ name: 'receipt_attachment_linked_no_delete', sql: "CREATE TRIGGER receipt_attachment_linked_no_delete BEFORE DELETE ON receipt_attachments FOR EACH ROW BEGIN IF OLD.order_id IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='linked receipt cannot be deleted'; END IF; END" });
    const immutable = ['id', 'tenant_id', 'store_id', 'member_id', 'uploader_id', 'name', 'mime', 'size', 'content', 'created_at'].map(column => `NOT(NEW.\`${column}\` <=> OLD.\`${column}\`)`).join(' OR ');
    triggers.push({ name: 'receipt_attachment_immutable', sql: `CREATE TRIGGER receipt_attachment_immutable BEFORE UPDATE ON receipt_attachments FOR EACH ROW BEGIN IF OLD.order_id IS NOT NULL OR ${immutable} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='receipt content is immutable'; END IF; END` });
    const [existing] = await connection.query('SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=?', [databaseName]);
    const names = new Set(existing.map(row => row.name));
    for (const trigger of triggers) if (!names.has(trigger.name)) await connection.query(trigger.sql);
    await connection.query('INSERT INTO schema_migrations(version) VALUES(1)');
    }
    const [receiptNameUpgrade] = await connection.query('SELECT version FROM schema_migrations WHERE version=2');
    if (!receiptNameUpgrade.length) {
      // Canonical extensions may be appended to a valid 180-character original name.
      await connection.query('ALTER TABLE receipt_attachments MODIFY COLUMN name VARCHAR(255) NOT NULL');
      await connection.query('INSERT INTO schema_migrations(version) VALUES(2)');
    }
    const [phoneJoinUpgrade] = await connection.query('SELECT version FROM schema_migrations WHERE version=3');
    if (!phoneJoinUpgrade.length) {
      const phoneDdl = [
        `CREATE TABLE IF NOT EXISTS wechat_phone_codes (code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, created_at ${STAMP} NOT NULL, expires_at ${STAMP} NOT NULL, KEY phone_code_expiry(expires_at)) ${ENGINE}`,
        `CREATE TABLE IF NOT EXISTS wechat_phone_claims (ticket_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, user_id ${ID}, openid_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, onboarding_ticket_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin, phone_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, created_at ${STAMP} NOT NULL, expires_at ${STAMP} NOT NULL, used_at ${STAMP}, coach_id ${ID}, FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(coach_id) REFERENCES coaches(id), KEY phone_claim_expiry(expires_at), KEY phone_claim_openid(openid_hash), KEY phone_claim_user(user_id)) ${ENGINE}`,
        `CREATE TABLE IF NOT EXISTS wechat_coach_links (coach_id ${ID} NOT NULL PRIMARY KEY, user_id ${ID} NOT NULL, phone_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, created_at ${STAMP} NOT NULL, FOREIGN KEY(coach_id) REFERENCES coaches(id), FOREIGN KEY(user_id) REFERENCES users(id), KEY wechat_coach_user(user_id)) ${ENGINE}`,
      ];
      for (const statement of phoneDdl) await connection.query(statement);
      await connection.query('INSERT INTO schema_migrations(version) VALUES(3)');
    }
    const [scheduleUpgrade] = await connection.query('SELECT version FROM schema_migrations WHERE version=4');
    if (!scheduleUpgrade.length) {
      await connection.query(`CREATE TABLE IF NOT EXISTS schedule_plans (id ${ID} NOT NULL PRIMARY KEY, tenant_id ${ID}, store_id ${ID}, data LONGTEXT NOT NULL, seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, UNIQUE KEY schedule_plans_seq(seq), KEY schedule_plans_tenant(tenant_id,store_id), CONSTRAINT schedule_plans_data_json CHECK(JSON_VALID(data))) ${ENGINE}`);
      await connection.query('INSERT INTO schema_migrations(version) VALUES(4)');
    }
    const [venueUpgrade] = await connection.query('SELECT version FROM schema_migrations WHERE version=5');
    if (!venueUpgrade.length) {
      await connection.query(`CREATE TABLE IF NOT EXISTS venues (id ${ID} NOT NULL PRIMARY KEY, tenant_id ${ID}, store_id ${ID}, data LONGTEXT NOT NULL, seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, UNIQUE KEY venues_seq(seq), KEY venues_tenant(tenant_id,store_id), CONSTRAINT venues_data_json CHECK(JSON_VALID(data))) ${ENGINE}`);
      await connection.query('INSERT INTO schema_migrations(version) VALUES(5)');
    }
    const [coachBillUpgrade] = await connection.query('SELECT version FROM schema_migrations WHERE version=6');
    if (!coachBillUpgrade.length) {
      await connection.query(`CREATE TABLE IF NOT EXISTS coach_bills (id ${ID} NOT NULL PRIMARY KEY, tenant_id ${ID}, store_id ${ID}, data LONGTEXT NOT NULL, seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, UNIQUE KEY coach_bills_seq(seq), KEY coach_bills_tenant(tenant_id,store_id), CONSTRAINT coach_bills_data_json CHECK(JSON_VALID(data))) ${ENGINE}`);
      await connection.query('INSERT INTO schema_migrations(version) VALUES(6)');
    }
    const [teamCodeUpgrade] = await connection.query('SELECT version FROM schema_migrations WHERE version=7');
    if (!teamCodeUpgrade.length) {
      await connection.query(`CREATE TABLE IF NOT EXISTS store_team_codes (store_id ${ID} NOT NULL PRIMARY KEY, tenant_id ${ID} NOT NULL, code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE, generation ${ID} NOT NULL, created_by ${ID} NOT NULL, created_at ${STAMP} NOT NULL, expires_at ${STAMP} NOT NULL, KEY team_code_tenant(tenant_id), KEY team_code_expiry(expires_at), FOREIGN KEY(store_id) REFERENCES stores(id), FOREIGN KEY(tenant_id) REFERENCES tenants(id), FOREIGN KEY(created_by) REFERENCES users(id)) ${ENGINE}`);
      await connection.query(`CREATE TABLE IF NOT EXISTS wechat_team_attempts (attempt_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, attempts INT UNSIGNED NOT NULL, resets_at ${STAMP} NOT NULL, KEY team_attempt_expiry(resets_at)) ${ENGINE}`);
      // DDL auto-commits in MySQL. Column inspection also makes a partially
      // interrupted migration safe to rerun without touching existing rows.
      const columns = [
        ['wechat_phone_claims', 'proof_method', "VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'wechat_phone'"],
        ['wechat_phone_claims', 'team_store_id', ID],
        ['wechat_phone_claims', 'team_tenant_id', ID],
        ['wechat_phone_claims', 'team_generation', ID],
        ['wechat_coach_links', 'join_method', "VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'wechat_phone'"],
      ];
      for (const [table, column, definition] of columns) {
        const [existing] = await connection.query('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?', [databaseName, table, column]);
        if (!existing.length) await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      }
      await connection.query('INSERT INTO schema_migrations(version) VALUES(7)');
    }
    const [studentInviteUpgrade] = await connection.query('SELECT version FROM schema_migrations WHERE version=8');
    if (!studentInviteUpgrade.length) {
      const studentDdl = [
        `CREATE TABLE IF NOT EXISTS member_wechat_invites (member_id ${ID} NOT NULL PRIMARY KEY, tenant_id ${ID} NOT NULL, store_id ${ID} NOT NULL, code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE, generation ${ID} NOT NULL, created_by ${ID} NOT NULL, created_at ${STAMP} NOT NULL, expires_at ${STAMP} NOT NULL, claimed_at ${STAMP}, claimed_user_id ${ID}, KEY student_invite_expiry(expires_at), FOREIGN KEY(member_id) REFERENCES members(id), FOREIGN KEY(tenant_id) REFERENCES tenants(id), FOREIGN KEY(created_by) REFERENCES users(id), FOREIGN KEY(claimed_user_id) REFERENCES users(id)) ${ENGINE}`,
        `CREATE TABLE IF NOT EXISTS wechat_student_claims (ticket_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, user_id ${ID}, openid_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, onboarding_ticket_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin, member_id ${ID} NOT NULL, tenant_id ${ID} NOT NULL, store_id ${ID} NOT NULL, generation ${ID} NOT NULL, created_at ${STAMP} NOT NULL, expires_at ${STAMP} NOT NULL, used_at ${STAMP}, KEY student_claim_expiry(expires_at), KEY student_claim_openid(openid_hash), FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(member_id) REFERENCES members(id)) ${ENGINE}`,
        `CREATE TABLE IF NOT EXISTS wechat_member_links (member_id ${ID} NOT NULL PRIMARY KEY, user_id ${ID} NOT NULL, tenant_id ${ID} NOT NULL, store_id ${ID} NOT NULL, created_at ${STAMP} NOT NULL, KEY wechat_member_user(user_id), FOREIGN KEY(member_id) REFERENCES members(id), FOREIGN KEY(user_id) REFERENCES users(id)) ${ENGINE}`,
        `CREATE TABLE IF NOT EXISTS wechat_student_attempts (attempt_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, attempts INT UNSIGNED NOT NULL, resets_at ${STAMP} NOT NULL, KEY student_attempt_expiry(resets_at)) ${ENGINE}`,
      ];
      for (const statement of studentDdl) await connection.query(statement);
      await connection.query('INSERT INTO schema_migrations(version) VALUES(8)');
    }
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
  }
}

export async function createMySQLDatabase(options = {}) {
  const configuration = mysqlOptions(options);
  const pool = mysql.createPool({
    ...configuration,
    charset: 'utf8mb4',
    timezone: 'Z',
    waitForConnections: true,
    queueLimit: 0,
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true,
    multipleStatements: false,
    flags: '-FOUND_ROWS',
  });
  let first;
  try {
    first = await pool.getConnection();
    await first.query("SET SESSION sql_mode='STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
    await initializeSchema(first, configuration.database);
  } catch (error) {
    first?.release();
    first = undefined;
    await pool.end();
    throw error;
  } finally { first?.release(); }
  const scope = new AsyncLocalStorage();
  let closed = false;
  function executor() {
    if (closed) throw new Error('MySQL connection pool is closed');
    return scope.getStore() ?? pool;
  }
  async function rows(sql, parameters) {
    const [result] = await executor().execute(sql, parameters);
    return result;
  }
  const database = {
    storageEngine: 'mysql',
    prepare(sql) {
      return {
        async all(...parameters) { return rows(sql, parameters); },
        async get(...parameters) { return (await rows(sql, parameters))[0]; },
        async run(...parameters) {
          const result = await rows(sql, parameters);
          return { changes: Number(result.affectedRows), lastInsertRowid: Number(result.insertId ?? 0) };
        },
      };
    },
    async exec(sql) { const [result] = await executor().query(sql); return result; },
    async transaction(run) {
      if (scope.getStore()) return run();
      const connection = await pool.getConnection();
      try {
        await connection.query("SET SESSION sql_mode='STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
        await connection.beginTransaction();
        // Replaces SQLite BEGIN IMMEDIATE: one authoritative revision lock across processes.
        await connection.execute("SELECT value FROM meta WHERE `key`='version' FOR UPDATE");
        const result = await scope.run(connection, run);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally { connection.release(); }
    },
    async close() { if (!closed) { closed = true; await pool.end(); } },
  };
  return database;
}
