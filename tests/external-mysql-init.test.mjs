import test from 'node:test';
import assert from 'node:assert/strict';
import { initializationPlan, initializeExternalDatabase } from '../deploy/init-external-mysql.mjs';

const runtime = { MYSQL_HOST: '192.0.2.20', MYSQL_PORT: '3306', MYSQL_DATABASE: 'lianduoduo', MYSQL_USER: 'business', MYSQL_PASSWORD: 'fixture-business-password' };

test('external initialization uses the requested runtime account unless administrator mode is explicit', () => {
  const plan = initializationPlan({ ...runtime, MYSQL_ROOT_PASSWORD: 'fixture-unused-root-password' });
  assert.equal(plan.options.host, runtime.MYSQL_HOST);
  assert.equal(plan.options.database, 'lianduoduo');
  assert.equal(plan.options.user, 'business');
  assert.equal(plan.options.password, runtime.MYSQL_PASSWORD);
  assert.equal(plan.administrator, false);
  assert.equal(plan.createDatabase, false);
});

test('explicit schema account and explicit root mode stay separate from the runtime account', () => {
  const schema = initializationPlan({ ...runtime, MYSQL_SCHEMA_USER: 'ddl_operator', MYSQL_SCHEMA_PASSWORD: 'fixture-ddl-password' });
  assert.equal(schema.options.user, 'ddl_operator');
  assert.equal(schema.options.password, 'fixture-ddl-password');
  assert.equal(schema.administrator, true);
  const root = initializationPlan({ ...runtime, MYSQL_INITIALIZE_AS_ADMIN: 'true', MYSQL_ROOT_PASSWORD: 'fixture-root-password' });
  assert.equal(root.options.user, 'root');
  assert.equal(root.options.password, 'fixture-root-password');
  assert.equal(runtime.MYSQL_USER, 'business');
});

test('ambiguous credentials, invalid identifiers and accidental create flags fail before connecting', () => {
  for (const extra of [
    { MYSQL_SCHEMA_USER: 'ddl_operator' }, { MYSQL_SCHEMA_PASSWORD: 'fixture-ddl-password' },
    { MYSQL_INITIALIZE_AS_ADMIN: 'true' }, { MYSQL_INITIALIZE_AS_ADMIN: 'yes' },
    { MYSQL_INITIALIZE_AS_ADMIN: 'true', MYSQL_ROOT_PASSWORD: 'fixture-root-password', MYSQL_SCHEMA_USER: 'ddl', MYSQL_SCHEMA_PASSWORD: 'fixture-ddl-password' },
    { MYSQL_CREATE_DATABASE: 'true' }, { MYSQL_CREATE_DATABASE: '1' },
    { MYSQL_DATABASE: 'other; DROP DATABASE lianduoduo' }, { MYSQL_HOST: '' }, { MYSQL_PORT: '0' },
  ]) assert.throws(() => initializationPlan({ ...runtime, ...extra }));
});

test('normal initialization only executes the existing idempotent schema migrator and closes its pool', async () => {
  const calls = [];
  const result = await initializeExternalDatabase(runtime, {
    connect() { assert.fail('Normal initialization must not create a database or connect as root.'); },
    async initializeSchema(options) { calls.push(['schema', options.database, options.user]); return { async close() { calls.push(['close']); } }; },
  });
  assert.deepEqual(calls, [['schema', 'lianduoduo', 'business'], ['close']]);
  assert.deepEqual(result, { initialized: true, createdDatabaseIfMissing: false });
});

test('missing database opt-in creates only the named database with administrator credentials then applies migrations', async () => {
  const calls = [];
  const environment = { ...runtime, MYSQL_INITIALIZE_AS_ADMIN: 'true', MYSQL_ROOT_PASSWORD: 'fixture-root-password', MYSQL_CREATE_DATABASE: 'true' };
  const result = await initializeExternalDatabase(environment, {
    async connect(options) { assert.equal(options.user, 'root'); assert.equal(options.database, undefined); assert.equal(options.connectionLimit, undefined); return { async query(sql) { calls.push(['sql', sql]); }, async end() { calls.push(['end']); } }; },
    async initializeSchema(options) { calls.push(['schema', options.database, options.user]); return { async close() { calls.push(['close']); } }; },
  });
  assert.deepEqual(calls, [['sql', 'CREATE DATABASE IF NOT EXISTS `lianduoduo` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin'], ['end'], ['schema', 'lianduoduo', 'root'], ['close']]);
  assert.equal(result.createdDatabaseIfMissing, true);
});

test('creation failure closes the administrative connection and never starts partial schema work', async () => {
  let ended = false, schemaStarted = false;
  await assert.rejects(initializeExternalDatabase({ ...runtime, MYSQL_SCHEMA_USER: 'ddl', MYSQL_SCHEMA_PASSWORD: 'fixture-ddl-password', MYSQL_CREATE_DATABASE: 'true' }, {
    async connect() { return { async query() { throw Object.assign(new Error('denied'), { code: 'ER_DBACCESS_DENIED_ERROR' }); }, async end() { ended = true; } }; },
    async initializeSchema() { schemaStarted = true; },
  }), { code: 'ER_DBACCESS_DENIED_ERROR' });
  assert.equal(ended, true);
  assert.equal(schemaStarted, false);
});
