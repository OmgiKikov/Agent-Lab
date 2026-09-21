import { test } from 'node:test';
import { mkdir, copyFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// CI contains only checked-out code and public npm dependencies. No env, auth directories,
// Git metadata, customer data or generated production logs are copied. No application source edits.
test('export isolated runtime for independent offline integration audit', {timeout:120000}, async () => {
  if (!process.env.GITHUB_ACTIONS) return;
  const out = resolve('.agent-lab/ci');
  await mkdir(out, {recursive:true});
  await copyFile(process.execPath, resolve('audit-node'));
  await chmod(resolve('audit-node'), 0o755);
  await promisify(execFile)('tar', ['-czf', resolve(out,'independent-audit-runtime.tar.gz'),
    'audit-node','dist','src','extensions','test','examples','skills','node_modules',
    'package.json','package-lock.json','tsconfig.json'], {maxBuffer:1024*1024});
  console.log('AUDIT_RUNTIME_EXPORTED: checked-out source, compiled code, public dependencies, Node binary; no credentials');
});
