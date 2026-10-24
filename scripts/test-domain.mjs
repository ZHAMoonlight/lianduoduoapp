import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const output = mkdtempSync(join(tmpdir(), 'lianduoduo-tests-'));
try {
  const args = ['node_modules/typescript/bin/tsc','--target','es2022','--module','commonjs','--moduleResolution','node','--esModuleInterop','--skipLibCheck','--types','node','--outDir',output,'--noEmit','false','tests/domain.test.ts','lib/domain.ts','lib/seed.ts','lib/types.ts','lib/request-auth.ts'];
  const compilation = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (compilation.status !== 0) process.exitCode = compilation.status || 1;
  else process.exitCode = spawnSync(process.execPath, ['--test', join(output,'tests/domain.test.js')], { stdio: 'inherit' }).status || 0;
} finally { rmSync(output, { recursive: true, force: true }); }
