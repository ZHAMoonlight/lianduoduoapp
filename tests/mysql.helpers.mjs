import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'mysql2/promise';

// Only test-specific settings are read: never fall back to the business database.
function testEnvironment() {
  const values = {};
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?(MYSQL_TEST_[A-Z_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '').trim();
      values[match[1]] = value;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...values, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('MYSQL_TEST_'))) };
}

export async function createMysqlFixture() {
  const env = testEnvironment();
  const port = Number(env.MYSQL_TEST_PORT);
  if (!env.MYSQL_TEST_HOST || !env.MYSQL_TEST_USER || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('真实 MySQL 测试需要 MYSQL_TEST_HOST/PORT/USER/PASSWORD；不会使用业务库。');
  const options = { host: env.MYSQL_TEST_HOST, port, user: env.MYSQL_TEST_USER, password: env.MYSQL_TEST_PASSWORD || '', database: `lianduoduo_test_${randomUUID().replaceAll('-', '')}`, connectionLimit: 6 };
  const admin = await createConnection({ host: options.host, port: options.port, user: options.user, password: options.password, connectTimeout: 10000 });
  try { await admin.query(`CREATE DATABASE \`${options.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`); }
  catch (error) { await admin.end(); throw error; }
  let disposed = false;
  return {
    options,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        if (!/^lianduoduo_test_[0-9a-f]{32}$/.test(options.database)) throw new Error('拒绝删除不属于本测试的数据库。');
        await admin.query(`DROP DATABASE \`${options.database}\``);
      } finally { await admin.end(); }
    }
  };
}
