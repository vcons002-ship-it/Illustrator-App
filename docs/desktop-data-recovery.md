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

In-app updates first export the active window's stores and settings to
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

The batch entry point copies its worker to a unique temporary `.bat` before any
pull. The call/exit block is parsed in advance, so replacing either repository
script during a pull cannot make cmd resume at the wrong byte offset. The small
temporary worker is retained for diagnostics. The installation root is passed
explicitly, not inferred from the temporary script's location.

Do not delete AppData, reset browser storage, use `--dev` to test recovery, weaken
Windows security, or copy a live LevelDB over another live LevelDB.

## Desktop session and phone-link lifecycle

The native app now keeps `desktop-session.json` in its per-user app-local-data
folder, outside `EBWebView`. It stores a renderer profile identifier and the
existing phone-link opt-in, token and port. Explicit developer mode uses a separate
`desktop-session-dev.json` so it cannot adopt the packaged app's pairing state or
collide with its profile guard. **It contains a pairing credential:
keep it private.** It is not served by the relay or included in shareable exports.
Closed-profile backups include it and WebView's `Local State` alongside IndexedDB
and Local Storage. No automatic migration of chat databases is attempted.

On first launch, the installed desktop establishes a profile identifier. On later
launches, a gate checks it before mounting App or enabling its autosaves. A mismatch
stops startup with recovery guidance; it does not overwrite the expected identity.
Establish the first baseline through the user's actual Explorer shortcut, not a
different launch context. This guard detects a changed identity, not missing rows
inside an otherwise matching profile; continue verifying actual chats after updates.

The renderer also anchors that identity in the chat database's `memos` store under
`desktop-profile-id:v1`. On subsequent launches this anchor takes precedence over
Local Storage. If Local Storage alone is cleared or its marker changes, the native
check must accept the database anchor before repairing the local marker. A rejected
database anchor or database read failure still blocks startup; it is never treated
as a fresh profile or silently replaced by a matching Local Storage value.

For a legacy profile already blocked before it received an anchor, the startup screen
offers a two-step recovery while App and its autosaves remain unmounted:

1. Inspect the saved-record counts, then **Save recovery backup**. Native code saves
   the full data export and an unchanged private `desktop-session.json` to a new
   `~/VisualReader/exports/profile-recovery-*` folder. It refuses empty/incomplete
   exports or missing native identity and never overwrites an earlier snapshot.
2. Inspect that backup for the expected chats and Soul records. Only if it is the
   correct saved profile, choose **Use this backed-up saved profile**. This validates
   the existing native identity and writes only the two renderer identity markers,
   then reloads through the normal startup gate. It does not import/reset records,
   change the native identity, rotate the phone token, or weaken a profile mismatch.

If the inspected data is empty or unfamiliar, do not reattach it. Recover the correct
data export instead. All recovery files are private; do not upload them to an issue/PR.

An opted-in phone link restores from native metadata first. Legacy Local Storage
is used only for the first migration. An explicit Stop persists the disabled state;
internal restart/update handoffs release the socket without disabling the link.
The retiring renderer pauses its bridge reconnect loop and settings autosaves
during that handoff, resuming them only if the replacement fails and rolls back.
Only Change link rotates the credential. Concurrent startup requests are serialized
and an already-running matching relay is reused instead of restarted.

In-app Restart and packaged Update now wait up to 40 seconds for an acknowledgement
from the replacement UI after profile validation and an IndexedDB read. If the phone
link was enabled, the acknowledgement additionally requires a real chat snapshot
through the restored relay, not just a listening TCP port. A failed handoff terminates
the unverified replacement and retains the original app and restores its relay.
This is a local readiness check, not proof that Cloudflare Access, a tunnel, or a
particular phone is reachable. Batch updates still build while closed; verify the
actual shortcut and mobile connection after launching them.

The phone labels a socket open as waiting for the desktop, and becomes Linked only
after applying a conversation snapshot. Pairing rejection (WebSocket 1008) gives a
clear instruction to reopen the current link instead of retrying forever. Network
failures still reconnect, with backoff reset only after a verified snapshot.
Older phone pages must refresh to load this behavior. Do not accept revoked tokens
or disable authentication to conceal a pairing mismatch.

If encrypted API-key material cannot be decrypted, normal settings autosaves retain
the ciphertext rather than silently deleting it. This cannot recreate a missing
device key; manual key re-entry or a matching private vault backup may still be needed.
