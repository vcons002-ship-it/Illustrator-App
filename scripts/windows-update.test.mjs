import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function runUpdate({ buildExit = 0, backupExit = 0, running = false, input = '\r\n', producesExe = true } = {}) {
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
    writeFileSync(join(dir, 'node.cmd'), `@echo MOCK_node %*\r\n@exit /b ${backupExit}\r\n`);
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
test('backup failure stops before pulling or building', windows, () => {
  const r = runUpdate({ backupExit: 1 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /backup-desktop-profile/);
  assert.doesNotMatch(r.stdout, /MOCK_git|MOCK_pnpm|MOCK_DESKTOP_BUILD/);
});
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

test('desktop setup and normal launch use the shortcut data origin, with dev explicitly opt-in', () => {
  const setup = readFileSync(join(root, 'desktop.bat'), 'utf8');
  assert.match(setup.slice(setup.indexOf(':launch\n') >= 0 ? setup.indexOf(':launch\n') : setup.indexOf(':launch\r\n')), /call "%~dp0desktop-prod\.bat"/);
  assert.doesNotMatch(setup, /call cargo tauri dev/);
  const launch = readFileSync(join(root, 'run-desktop.bat'), 'utf8');
  assert.match(launch, /if \/i "%~1"=="--dev" goto :dev/);
  assert.match(launch, /start "" "%EXE%"/);
  assert.ok(launch.indexOf('windows-desktop-closed.bat') < launch.indexOf('start "" "%EXE%"'));
  assert.ok(launch.indexOf(':dev') < launch.indexOf('call cargo tauri dev'));
  assert.match(launch, /separate data store/);
});

function runLauncher({ dev = false, buildExit = 0, running = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'visual-reader-launch-test-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'apps/desktop/src-tauri'), { recursive: true });
    copyFileSync(join(root, 'run-desktop.bat'), join(dir, 'run-desktop.bat'));
    copyFileSync(join(root, 'scripts/windows-desktop-closed.bat'), join(dir, 'scripts/windows-desktop-closed.bat'));
    writeFileSync(join(dir, 'scripts/windows-tool-path.bat'), '@exit /b 0\r\n');
    writeFileSync(join(dir, 'tasklist.cmd'), running ? '@echo visual-reader-desktop.exe 1234 Console\r\n' : '@echo INFO: No tasks match.\r\n');
    writeFileSync(join(dir, 'desktop-prod.bat'), `@echo MOCK_PACKAGED_BUILD\r\n@exit /b ${buildExit}\r\n`);
    writeFileSync(join(dir, 'cargo.cmd'), `@echo off\r\nif "%2"=="--version" exit /b 0\r\necho MOCK_CARGO %*\r\nexit /b ${buildExit}\r\n`);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env.PATH = `${dir};${env.SystemRoot}\\System32;${env.SystemRoot}`;
    env.USERPROFILE = dir;
    return spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `run-desktop.bat${dev ? ' --dev' : ''}`], {
      cwd: dir, env, input: '\r\n', encoding: 'utf8', timeout: 15000,
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('missing packaged executable builds packaged mode and propagates failure', windows, () => {
  const result = runLauncher({ buildExit: 7 });
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.match(result.stdout, /MOCK_PACKAGED_BUILD/);
  assert.doesNotMatch(result.stdout, /MOCK_CARGO|DEVELOPER MODE/);
});
test('normal desktop launch refuses a second running desktop without building', windows, () => {
  const result = runLauncher({ running: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /MOCK_PACKAGED_BUILD|MOCK_CARGO/);
});
test('explicit dev launch warns about the separate data store and propagates failure', windows, () => {
  const result = runLauncher({ dev: true, buildExit: 7 });
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.match(result.stdout, /DEVELOPER MODE/);
  assert.match(result.stdout, /MOCK_CARGO tauri dev/);
  assert.doesNotMatch(result.stdout, /MOCK_PACKAGED_BUILD/);
});
