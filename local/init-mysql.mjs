import { loadLocalEnvironment } from './env.mjs';
import { createMySQLDatabase } from '../server/database.mjs';

loadLocalEnvironment();
if (!process.env.MYSQL_ROOT_PASSWORD) throw new Error('初始化需要 .env 中的 MYSQL_ROOT_PASSWORD；应用运行仍使用 MYSQL_USER。');
const database = await createMySQLDatabase({
  user: process.env.MYSQL_SCHEMA_USER || 'root',
  password: process.env.MYSQL_ROOT_PASSWORD,
});
await database.close();
console.log('MySQL 表结构与历史保护已初始化；应用使用独立业务账号连接。');
