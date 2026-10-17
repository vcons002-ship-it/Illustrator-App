import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// Caller MUST close Visual Reader first. Never move, clear or overwrite the live profile.
export function backupDesktopProfile({ localAppData, userProfile, now = new Date() }) {
  if (!localAppData || !userProfile) throw new Error('LOCALAPPDATA and USERPROFILE are required.');
  const profile = resolve(localAppData, 'com.visualreader.app', 'EBWebView');
  if (!existsSync(profile)) {
    console.log('[i] No desktop profile in this execution context; no existing data was changed.');
    return undefined;
  }
  const destination = resolve(userProfile, 'VisualReader', 'backups', `before-update-${now.toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(destination, { recursive: true });
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing linked profile data: ${path}`);
      if (entry.isDirectory()) visit(path);
      else files.push({ path: relative(destination, path), bytes: statSync(path).size,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
    }
  }
  for (const name of ['IndexedDB', 'Local Storage']) {
    const source = join(profile, 'Default', name);
    if (existsSync(source)) cpSync(source, join(destination, 'Default', name), { recursive: true, errorOnExist: true, force: false });
  }
  // These are private recovery snapshots, not shareable JSON exports. Include lifecycle metadata
  // and WebView encryption/profile metadata so the pairing and key vault can be recovered together.
  for (const [source, name] of [
    [join(profile, 'Local State'), 'Local State'],
    [join(profile, '..', 'desktop-session.json'), 'desktop-session.json'],
  ]) {
    if (existsSync(source)) cpSync(source, join(destination, name), { errorOnExist: true, force: false });
  }
  visit(destination);
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ profile, at: now.toISOString(), files,
    warning: 'This snapshot belongs to the execution context that ran the updater. Verify the actual desktop shortcut after updating. Never delete the live profile to repair a blank launch.' }, null, 2), { flag: 'wx' });
  console.log(`[OK] Saved ${files.length} profile files to ${destination}`);
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { backupDesktopProfile({ localAppData: process.env.LOCALAPPDATA, userProfile: process.env.USERPROFILE }); }
  catch (error) { console.error(`[X] Profile backup failed. Update stopped: ${error.message}`); process.exitCode = 1; }
}
