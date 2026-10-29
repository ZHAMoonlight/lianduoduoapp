import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const output = mkdtempSync(join(tmpdir(), 'lianduoduo-tests-'));
try {
  const args = ['node_modules/typescript/bin/tsc','--target','es2022','--module','commonjs','--moduleResolution','node','--esModuleInterop','--skipLibCheck','--types','node','--outDir',output,'--noEmit','false','tests/domain.test.ts','tests/scheduling.test.ts','tests/schedule-plans.test.ts','tests/multicoach-schedule.test.ts','tests/venues.test.ts','tests/coach-billing.test.ts','tests/card-courses.test.ts','tests/coach-reservations.test.ts','tests/coach-stores.test.ts','lib/scheduling.ts','lib/schedule-plans.ts','lib/venues.ts','lib/coach-billing.ts','lib/card-courses.ts','lib/domain.ts','lib/seed.ts','lib/types.ts','lib/request-auth.ts'];
  const compilation = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (compilation.status !== 0) process.exitCode = compilation.status || 1;
  else process.exitCode = spawnSync(process.execPath, ['--test', join(output,'tests/domain.test.js'),join(output,'tests/scheduling.test.js'),join(output,'tests/schedule-plans.test.js'),join(output,'tests/multicoach-schedule.test.js'),join(output,'tests/venues.test.js'),join(output,'tests/coach-billing.test.js'),join(output,'tests/card-courses.test.js'),join(output,'tests/coach-reservations.test.js'),join(output,'tests/coach-stores.test.js')], { stdio: 'inherit' }).status || 0;
} finally { rmSync(output, { recursive: true, force: true }); }
