import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDesktopProfile } from './backup-desktop-profile.mjs';

test('copies profile stores without changing source and records verified hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'vr-profile-test-'));
  try {
    const source = join(root, 'local/com.visualreader.app/EBWebView/Default/IndexedDB/db');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, '000001.ldb'), 'saved data');
    const dest = backupDesktopProfile({ localAppData: join(root, 'local'), userProfile: root });
    const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json')));
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].sha256.length, 64);
    assert.equal(readFileSync(join(source, '000001.ldb'), 'utf8'), 'saved data');
    assert.equal(readFileSync(join(dest, manifest.files[0].path), 'utf8'), 'saved data');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing profile is reported without creating a fresh replacement', () => {
  assert.equal(backupDesktopProfile({ localAppData: join(tmpdir(), 'vr-absent-profile'), userProfile: tmpdir() }), undefined);
});

test('private snapshot includes pairing lifecycle and WebView encryption metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'vr-lifecycle-backup-test-'));
  try {
    const app = join(root, 'local/com.visualreader.app');
    mkdirSync(join(app, 'EBWebView'), { recursive: true });
    writeFileSync(join(app, 'desktop-session.json'), '{"phone":"private fixture"}');
    writeFileSync(join(app, 'EBWebView/Local State'), 'webview metadata');
    const dest = backupDesktopProfile({ localAppData: join(root, 'local'), userProfile: root });
    const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json')));
    assert.equal(manifest.files.length, 2);
    assert.equal(readFileSync(join(dest, 'desktop-session.json'), 'utf8'), '{"phone":"private fixture"}');
    assert.equal(readFileSync(join(dest, 'Local State'), 'utf8'), 'webview metadata');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
