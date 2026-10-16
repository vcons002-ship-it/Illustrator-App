# Desktop data and update verification

The packaged app uses `http://tauri.localhost` and WebView2's
`%LOCALAPPDATA%\com.visualreader.app\EBWebView`. Developer mode has a separate origin.
The executable path, origin and Windows account alone do **not** prove that two
launch contexts see the same filesystem/profile. On 2026-10-16 an Explorer launch
showed an empty database while an automation launch of the same binary showed the
populated database at the same apparent path. The isolation mechanism remains
unconfirmed; no evidence established that the updater deleted the data.

## Safe recovery

1. Export **both** views with Settings → Backup & restore → Export backup.
   Backups are local files in `~/VisualReader/exports`; keep them private.
2. Close all app windows. Double-click the exact user's desktop shortcut **in
   Explorer**, rather than launching a successor from the automation/build process.
3. Restore the populated export in that window. Restore merges records by key;
   it does not clear the destination. API keys may need re-entry. Re-renderable
   book illustration caches are not part of the JSON export.
4. Close normally and reopen the same shortcut. Verify saved chats, projects,
   Souls and attachments. A process surviving startup is not a data verification.

## Safeguards

In-app updates first export the active window's stores and non-secret settings to
a timestamped `visual-reader-pre-update-*.json`. A failed export stops the update.
`update.bat` requires the app closed and snapshots IndexedDB plus Local Storage to
`~/VisualReader/backups/before-update-*` before pulling code. Neither path resets,
moves or deletes the live profile. File snapshots apply only to the context that
ran the updater; they are not proof of the Explorer view.

`scripts/repair-desktop-shortcut.ps1 -InstallRoot C:\Illustrator-App` backs up and
repairs the existing **Visual Reader - Qwen 2.1** shortcut to the packaged exe,
with the install root as Start in and no developer flags. Its historical name does
not restrict image models. It does not migrate data or change WebView2 profiles.
After each deployment, repeat step 4 from Explorer before calling it verified.

Do not delete AppData, reset browser storage, use `--dev` to test recovery, weaken
Windows security, or copy a live LevelDB over another live LevelDB.
