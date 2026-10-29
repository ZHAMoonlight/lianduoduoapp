import mysql from 'mysql2/promise';
import { pathToFileURL } from 'node:url';
import { createMySQLDatabase } from '../server/database.mjs';

function flag(value, name) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be true or false.`);
}

export function initializationPlan(environment = process.env) {
  const database = environment.MYSQL_DATABASE;
  if (!database || !/^[A-Za-z0-9_]{1,64}$/.test(database)) throw new Error('MYSQL_DATABASE must be a valid database identifier.');
  const host = environment.MYSQL_HOST, port = Number(environment.MYSQL_PORT || 3306);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MYSQL_HOST and MYSQL_PORT must identify the intended MySQL server.');
  const explicitSchema = !!(environment.MYSQL_SCHEMA_USER || environment.MYSQL_SCHEMA_PASSWORD);
  if (explicitSchema && (!environment.MYSQL_SCHEMA_USER || !environment.MYSQL_SCHEMA_PASSWORD)) throw new Error('MYSQL_SCHEMA_USER and MYSQL_SCHEMA_PASSWORD must be provided together.');
  const rootMode = flag(environment.MYSQL_INITIALIZE_AS_ADMIN, 'MYSQL_INITIALIZE_AS_ADMIN');
  if (rootMode && explicitSchema) throw new Error('Choose one initialization administrator configuration.');
  if (rootMode && !environment.MYSQL_ROOT_PASSWORD) throw new Error('Administrator initialization requires MYSQL_ROOT_PASSWORD.');
  const administrator = explicitSchema || rootMode;
  const user = explicitSchema ? environment.MYSQL_SCHEMA_USER : rootMode ? 'root' : environment.MYSQL_USER;
  const password = explicitSchema ? environment.MYSQL_SCHEMA_PASSWORD : rootMode ? environment.MYSQL_ROOT_PASSWORD : environment.MYSQL_PASSWORD;
  if (!user || !password) throw new Error('The selected initialization account requires a user and password.');
  const createDatabase = flag(environment.MYSQL_CREATE_DATABASE, 'MYSQL_CREATE_DATABASE');
  if (createDatabase && !administrator) throw new Error('Creating a database requires an explicitly selected initialization administrator.');
  return { options: { host, port, database, user, password, connectionLimit: 1 }, administrator, createDatabase };
}

export async function initializeExternalDatabase(environment = process.env, dependencies = {}) {
  const plan = initializationPlan(environment);
  if (plan.createDatabase) {
    const { database, host, port, user, password } = plan.options;
    const connectionOptions = { host, port, user, password };
    const connection = await (dependencies.connect || mysql.createConnection)(connectionOptions);
    try { await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`); }
    finally { await connection.end(); }
  }
  const database = await (dependencies.initializeSchema || createMySQLDatabase)(plan.options);
  await database.close();
  return { initialized: true, createdDatabaseIfMissing: plan.createDatabase };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  initializeExternalDatabase().then(result => console.log(JSON.stringify(result))).catch(error => {
    // Connection errors may contain server details. Never print the environment or credentials.
    console.error('External MySQL initialization failed:', error.code || error.message);
    process.exitCode = 1;
  });
}
