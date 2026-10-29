import { spawnSync } from 'node:child_process';
import { compileLocalDomain } from '../scripts/compile-local.mjs';
import { projectRoot } from './env.mjs';
process.chdir(projectRoot);
compileLocalDomain();
const result = spawnSync(process.execPath, ['--test', 'tests/http-policy.test.mjs', 'tests/deploy-policy.integration.mjs', 'tests/local.integration.mjs', 'tests/mysql-migration.test.mjs', 'tests/wechat-phone.integration.mjs', 'tests/wechat-phone-exchange.test.mjs', 'tests/team-codes.integration.mjs', 'tests/student-invites.integration.mjs', 'tests/coach-reservations.integration.mjs', 'tests/coach-stores.integration.mjs', 'tests/schedule-plans.integration.mjs', 'tests/multicoach.integration.mjs', 'tests/venues.integration.mjs', 'tests/coach-billing.integration.mjs', 'tests/card-courses.integration.mjs'], { stdio: 'inherit', env: { ...process.env, WECHAT_APP_ID: '', WECHAT_APP_SECRET: '' } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
