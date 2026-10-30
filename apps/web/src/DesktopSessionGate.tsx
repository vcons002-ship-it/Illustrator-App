import { useEffect, useMemo, useState, type ReactNode } from "react";
import { IndexedDbStore, type StoreBackup } from "@visual-reader/core";
import { checkDesktopSession, isDesktop, saveExportFile, saveProfileRecovery } from "./runtime.js";
import { attachBackedUpProfile, DESKTOP_PROFILE_MEMO, verifyDesktopProfile } from "./desktop-profile.js";
import { dataBackupPayload } from "./data-backup.js";
import { restoreProfileBackup } from "./desktop-profile-restore.js";

/** Do not mount App (and its autosaves) inside an unexpected WebView data profile. */
export function DesktopSessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState(isDesktop ? "checking" : "ready");
  const store = useMemo(() => isDesktop ? new IndexedDbStore() : undefined, []);
  const anchor = useMemo(() => ({
    read: () => store!.getMemo(DESKTOP_PROFILE_MEMO),
    write: (id: string) => store!.putMemo(DESKTOP_PROFILE_MEMO, id),
  }), [store]);
  const [snapshot, setSnapshot] = useState<StoreBackup>();
  const [receipt, setReceipt] = useState<{ profileId: string; backupPath: string }>();
  const [working, setWorking] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    void (async () => {
      try {
        await verifyDesktopProfile(localStorage, checkDesktopSession, () => crypto.randomUUID(), anchor);
        if (!cancelled) setState("ready");
      } catch (error) {
        if (!cancelled) setState(String(error));
        // Read-only inspection while App and its autosaves remain unmounted.
        try {
          const data = await store!.exportData();
          if (!cancelled) setSnapshot(data);
        } catch {
          if (!cancelled) setRecoveryError("Could not read saved data. Recovery is blocked; keep the files and restore a verified backup.");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [anchor, store]);
  const saveBackup = async () => {
    if (!snapshot || working) return;
    setWorking(true); setRecoveryError("");
    try {
      setReceipt(await saveProfileRecovery(JSON.stringify(dataBackupPayload(snapshot,
        localStorage.getItem("vr-settings") ?? undefined, location.origin))));
    } catch (error) { setRecoveryError(String(error)); }
    finally { setWorking(false); }
  };
  const recover = async () => {
    if (!receipt || working) return;
    setWorking(true); setRecoveryError("");
    try {
      await attachBackedUpProfile(receipt.profileId, localStorage, anchor, checkDesktopSession);
      location.reload(); // fresh startup must pass the same guard before App can mount
    } catch (error) { setRecoveryError(String(error)); setWorking(false); }
  };
  const restore = async (file: File) => {
    if (!snapshot || working) return;
    setWorking(true); setRecoveryError("");
    try {
      await restoreProfileBackup({ raw: await file.text(), store: store!, storage: localStorage,
        anchor, check: checkDesktopSession, origin: location.origin,
        saveCurrent: (json) => saveExportFile(`visual-reader-before-startup-restore-${Date.now()}.json`, json, "application/json"),
        saveIncoming: saveProfileRecovery,
      });
      location.reload();
    } catch (error) { setRecoveryError(String(error)); setWorking(false); }
  };
  if (state === "ready") return children;
  const counts = Object.fromEntries(Object.entries(snapshot?.stores ?? {}).map(([name, rows]) => [name, rows.length]));
  const populated = (counts.chats ?? 0) + (counts.books ?? 0) + (counts.bibles ?? 0) > 0;
  const buttonStyle = { padding: "12px 18px", margin: "12px 8px 0 0", color: "#111", background: "#eee", borderRadius: 8 };
  return <main style={{ padding: 32, minHeight: "100vh", background: "#151922", color: "#f0f2f8" }} role="alert">
    <h1>{state === "checking" ? "Checking saved desktop session…" : "Saved-data profile needs attention"}</h1>
    {state !== "checking" && <p>{state}</p>}
    {snapshot && <section style={{ maxWidth: 800 }}>
      <h2>Inspect saved data before recovery</h2>
      <p>This database contains {counts.chats ?? 0} saved chats, {counts.books ?? 0} books,
        {" "}{counts.bibles ?? 0} visual bibles, {counts.memos ?? 0} memory records and {counts.chatblobs ?? 0} attachments.</p>
      <p>A changed Local Storage marker does not mean these records were deleted. Only use this profile
        if its backup contains your expected chats and Soul information. If it is empty or unfamiliar,
        keep it blocked and restore the correct backup instead.</p>
      {!receipt ? <button style={buttonStyle} disabled={!populated || working} onClick={() => void saveBackup()}>
        {working ? "Saving private backup…" : "Save recovery backup"}
      </button> : <>
        <p>Private backup saved: {receipt.backupPath}. The original desktop identity and phone link are unchanged.</p>
        <button style={buttonStyle} disabled={working} onClick={() => void recover()}>
          {working ? "Recovering saved profile…" : "Use this backed-up saved profile"}
        </button>
      </>}
      <h2>Restore the correct saved-data export</h2>
      <p>If this launch is empty or older, select your verified backup. The current records and the
        selected export will be saved privately before a merge-only restore. No assistant jobs run
        until the restored profile passes the normal startup check.</p>
      <label>Verified Visual Reader backup (JSON){" "}
        <input type="file" accept=".json,application/json" disabled={working} onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void restore(file);
          event.target.value = "";
        }} />
      </label>
      {working && <p>Saving backups and restoring saved data. Please keep this window open…</p>}
    </section>}
    {recoveryError && <p>{recoveryError}</p>}
  </main>;
}
