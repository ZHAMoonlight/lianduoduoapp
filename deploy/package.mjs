import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const common = [
  '.dockerignore', '.env.production.example', 'compose.production.yml',
  'Dockerfile.prebuilt', 'Dockerfile.prebuilt.dockerignore',
  'server', 'local/env.mjs', 'local/init-mysql.mjs',
  'deploy/start.mjs', 'deploy/README.md',
  'deploy/runtime/package.json', 'deploy/runtime/package-lock.json',
];
const source = [
  'Dockerfile', 'package.json', 'package-lock.json', 'index.html',
  'vite.local.config.ts', 'tsconfig.json', 'app', 'frontend', 'lib', 'public',
  'scripts/compile-local.mjs', 'deploy/package.mjs',
];
const artifacts = ['.local-runtime', 'dist-local/client'];
const excludedDirectories = new Set(['node_modules', 'outputs', '.git', '.next', '.wrangler', '.codex', '.agents', 'coverage', 'data']);
const excludedFile = /\.(?:pem|key|sql|sqlite|db|tar|tgz|gz|log|tsbuildinfo)$/i;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function inventory(inputs) {
  const files = new Map();
  function walk(relative, explicit = false) {
    const name = path.basename(relative);
    if (!explicit && (excludedDirectories.has(name) || name.startsWith('.env') || excludedFile.test(name) || name === '.DS_Store')) return;
    if (relative.startsWith('.env') && relative !== '.env.production.example') throw new Error('Environment files cannot be packaged.');
    const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Deployment input contains an unexpected symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) walk(path.join(relative, entry));
    } else if (stat.isFile()) {
      files.set(relative.split(path.sep).join('/'), { bytes: stat.size, sha256: sha256(fs.readFileSync(absolute)) });
      if (files.size > 10000) throw new Error('Unexpected deployment input count.');
    } else throw new Error(`Deployment input is not a regular file: ${relative}`);
  }
  inputs.forEach(input => walk(input, true));
  return new Map([...files.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed with exit code ${result.status}.`);
  return result;
}

async function main() {
  let mode = 'source', output;
  for (let i = 2; i < process.argv.length; i += 1) {
    const argument = process.argv[i];
    if (argument === '--prebuilt') mode = 'prebuilt';
    else if (argument === '--source') mode = 'source';
    else if (argument === '--output' && process.argv[i + 1]) output = path.resolve(process.argv[++i]);
    else throw new Error('Usage: node deploy/package.mjs [--prebuilt|--source] [--output /absolute/release.tar.gz]');
  }
  output ||= path.join(root, 'outputs', 'deploy', `lianduoduo-${mode}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.tar.gz`);
  if (!output.endsWith('.tar.gz')) throw new Error('The output filename must end with .tar.gz.');
  const checksumFile = output + '.sha256';
  if (fs.existsSync(output) || fs.existsSync(checksumFile)) throw new Error('The deployment archive or checksum already exists; use a new release filename.');
  const before = inventory([...common, ...source]);
  let compiled;
  if (mode === 'prebuilt') {
    const { compileLocalDomain } = await import('../scripts/compile-local.mjs');
    compiled = compileLocalDomain();
    run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.local.config.ts'], { env: { ...process.env, NODE_ENV: 'production' } });
    for (const entry of ['.local-runtime/lib/domain.js', '.local-runtime/package.json', 'dist-local/client/index.html']) {
      if (!fs.existsSync(path.join(root, entry))) throw new Error(`Required prebuilt artifact is missing: ${entry}`);
    }
  }
  const after = inventory([...common, ...source]);
  if (JSON.stringify([...before]) !== JSON.stringify([...after])) throw new Error('Source changed during packaging; freeze source edits and build the release again.');
  const selected = inventory(mode === 'prebuilt' ? [...common, ...artifacts] : [...common, ...source]);
  const sourceDigest = sha256(JSON.stringify([...after]));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lianduoduo-release-'));
  const temporaryArchive = path.join(path.dirname(output), `.${path.basename(output)}.tmp-${randomUUID()}`);
  try {
    fs.chmodSync(stage, 0o700);
    for (const [relative, metadata] of selected) {
      const target = path.join(stage, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const bytes = fs.readFileSync(path.join(root, relative));
      if (sha256(bytes) !== metadata.sha256) throw new Error(`Source changed while copying ${relative}; package again after edits stop.`);
      fs.writeFileSync(target, bytes, { mode: 0o644, flag: 'wx' });
    }
    const manifest = {
      format: 1, mode, createdAt: new Date().toISOString(),
      sourceDigest, node: process.version,
      ...(compiled ? { compiledDomainFiles: compiled.count } : {}),
      files: Object.fromEntries(selected),
    };
    fs.writeFileSync(path.join(stage, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
    run('tar', [...(process.platform === 'darwin' ? ['--no-xattrs'] : []), '-czf', temporaryArchive, '-C', stage, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    fs.chmodSync(temporaryArchive, 0o600);
    fs.copyFileSync(temporaryArchive, output, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(output, 0o600);
    const digest = sha256(fs.readFileSync(output));
    fs.writeFileSync(checksumFile, `${digest}  ${path.basename(output)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ mode, archive: output, checksum: checksumFile, sha256: digest, bytes: fs.statSync(output).size, files: selected.size + 1, sourceDigest }, null, 2));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(temporaryArchive, { force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
