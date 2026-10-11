import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function runUpdate({ buildExit = 0, running = false, input = '\r\n', producesExe = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'visual-reader-update-test-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'apps/desktop/src-tauri/target/release'), { recursive: true });
    copyFileSync(join(root, 'update.bat'), join(dir, 'update.bat'));
    copyFileSync(join(root, 'scripts/windows-desktop-closed.bat'), join(dir, 'scripts/windows-desktop-closed.bat'));
    writeFileSync(join(dir, 'scripts/windows-tool-path.bat'), '@exit /b 0\r\n');
    writeFileSync(join(dir, 'tasklist.cmd'), running ? '@echo visual-reader-desktop.exe 1234 Console\r\n' : '@echo INFO: No tasks match.\r\n');
    for (const tool of ['git', 'node', 'pnpm']) {
      writeFileSync(join(dir, `${tool}.cmd`), `@echo MOCK_${tool} %*\r\n@exit /b 0\r\n`);
    }
    writeFileSync(join(dir, 'cargo.cmd'), `@echo off\r\nif "%2"=="--version" exit /b 0\r\necho MOCK_DESKTOP_BUILD %*\r\nexit /b ${buildExit}\r\n`);
    if (producesExe) writeFileSync(join(dir, 'apps/desktop/src-tauri/target/release/visual-reader-desktop.exe'), 'fixture');
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    // Keep the real toolchain out: these tests must never pull or build the user's app.
    env.PATH = `${dir};${env.SystemRoot}\\System32;${env.SystemRoot}`;
    env.USERPROFILE = dir;
    return spawnSync(process.env.ComSpec, ['/d', '/s', '/c', 'update.bat'], {
      cwd: dir, env, input, encoding: 'utf8', timeout: 15000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const windows = { skip: process.platform !== 'win32' };
test('desktop failure propagates without false success', windows, () => {
  const r = runUpdate({ buildExit: 7 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Desktop build failed/);
  assert.doesNotMatch(r.stdout, /Update complete|Desktop app rebuilt/);
});
test('Enter rebuilds the packaged desktop and fast-forwards only', windows, () => {
  const r = runUpdate();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /MOCK_git pull --ff-only/);
  assert.match(r.stdout, /MOCK_DESKTOP_BUILD tauri build --no-bundle/);
  assert.match(r.stdout, /Desktop app rebuilt/);
});
test('explicit skip explains the desktop executable remains old', windows, () => {
  const r = runUpdate({ input: 'n\r\n' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /shortcut still runs the OLD build/);
  assert.doesNotMatch(r.stdout, /MOCK_DESKTOP_BUILD/);
});
test('running app blocks before source or dependency changes', windows, () => {
  const r = runUpdate({ running: true });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Visual Reader is still running/);
  assert.doesNotMatch(r.stdout, /MOCK_git|MOCK_pnpm|MOCK_DESKTOP_BUILD/);
});
test('missing executable is not reported as successful', windows, () => {
  const r = runUpdate({ producesExe: false });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /desktop executable is missing/);
});
test('packaged launcher checks for running app before its build', () => {
  const source = readFileSync(join(root, 'desktop-prod.bat'), 'utf8');
  assert.ok(source.indexOf('windows-desktop-closed.bat') < source.indexOf('call cargo tauri build'));
  assert.doesNotMatch(source.slice(0, source.indexOf('windows-desktop-closed.bat')), /^pause$/m);
});
