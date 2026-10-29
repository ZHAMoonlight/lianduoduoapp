import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
export function compileLocalDomain() {
  const output = path.join(root, '.local-runtime');
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'package.json'), '{"type":"commonjs"}\n');
  let count = 0;
  function compile(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) { compile(source); continue; }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts') || entry.name === 'workspace-store.ts') continue;
      const content = readFileSync(source, 'utf8');
      if (content.includes('cloudflare:workers')) continue;
      const relative = path.relative(root, source).replace(/\.ts$/, '.js');
      const dest = path.join(output, relative);
      mkdirSync(path.dirname(dest), { recursive: true });
      const result = ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: source, reportDiagnostics: true });
      const failures = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
      if (failures.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(failures, { getCanonicalFileName: v => v, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
      writeFileSync(dest, result.outputText);
      count++;
    }
  }
  compile(path.join(root, 'lib'));
  return { directory: output, count };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(compileLocalDomain()));
