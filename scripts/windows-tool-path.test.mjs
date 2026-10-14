import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
test('installed build tools are discoverable from a stale GUI PATH', {
  skip: process.platform !== 'win32',
}, () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env.PATH = `${env.SystemRoot}\\System32;${env.SystemRoot}`;
  const run = (command) => spawnSync(process.env.ComSpec, ['/d', '/s', '/c', command], {
    cwd: root, env, encoding: 'utf8', timeout: 30000,
  });
  const before = run('pnpm --version');
  assert.notEqual(before.status, 0, 'fixture must reproduce missing pnpm');
  const after = run('call scripts\\windows-tool-path.bat && node --version && call pnpm --version && cargo tauri --version');
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.match(after.stdout, /tauri-cli/);
});

test('a stray PATH quote cannot hide pnpm from cmd or a nested build', {
  skip: process.platform !== 'win32',
}, () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${env.SystemRoot}\\System32;C:\\broken-entry";${env.ProgramFiles}\\nodejs;${env.APPDATA}\\npm`;
  const parentPath = process.env.PATH;
  const run = command => spawnSync(process.env.ComSpec, ['/d', '/s', '/c', command], {
    cwd: root, env, encoding: 'utf8', timeout: 30000,
  });
  const before = run('where pnpm && call pnpm --version');
  assert.match(before.stdout, /pnpm\.cmd/);
  assert.notEqual(before.status, 0, 'fixture reproduces where finding pnpm but cmd failing to run it');
  const after = run('call scripts\\windows-tool-path.bat && node --version && call pnpm --version && cmd /d /c pnpm --version && cargo tauri --version');
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.match(after.stdout, /tauri-cli/);
  assert.equal(process.env.PATH, parentPath, 'normalization must not alter the parent environment');
});

test('quoted directories with spaces still resolve after normalization', {
  skip: process.platform !== 'win32',
}, () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${env.SystemRoot}\\System32;"${env.ProgramFiles}\\nodejs";"${env.APPDATA}\\npm"`;
  const result = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', 'call scripts\\windows-tool-path.bat && node --version && call pnpm --version'], {
    cwd: root, env, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
