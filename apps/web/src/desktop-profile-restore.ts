import type { StoreBackup } from "@visual-reader/core";
import { attachBackedUpProfile, type ProfileAnchor } from "./desktop-profile.js";
import { dataBackupPayload } from "./data-backup.js";

/** A blocked/empty shortcut profile must be restored BEFORE App, its jobs or autosaves mount. */
export async function restoreProfileBackup(options: {
  raw: string;
  store: { exportData(): Promise<StoreBackup>; importData(data: StoreBackup): Promise<void> };
  storage: Pick<Storage, "getItem" | "setItem">;
  anchor: ProfileAnchor;
  check: (id: string) => Promise<void>;
  saveCurrent: (json: string) => Promise<unknown>;
  saveIncoming: (json: string) => Promise<{ profileId: string }>;
  origin: string;
}): Promise<void> {
  const incoming = JSON.parse(options.raw) as StoreBackup & { settings?: string };
  const names = ["chats", "books", "bibles", "memos", "chatblobs"];
  if (!incoming || incoming.app !== "visual-reader" || !incoming.stores ||
      names.some((name) => !Array.isArray(incoming.stores[name]))) throw Error("Not a complete Visual Reader backup.");
  const populated = incoming.stores.books!.length + incoming.stores.bibles!.length > 0 ||
    incoming.stores.chats!.some((row) => Array.isArray(row.value) && row.value.length > 0);
  if (!populated) throw Error("Selected backup is empty. Choose the verified saved-data export.");
  if (incoming.settings !== undefined) {
    if (typeof incoming.settings !== "string") throw Error("Backup settings must be an object.");
    const settings: unknown = JSON.parse(incoming.settings);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw Error("Backup settings must be an object.");
  }
  const current = await options.store.exportData();
  await options.saveCurrent(JSON.stringify(dataBackupPayload(current, options.storage.getItem("vr-settings") ?? undefined, options.origin)));
  const receipt = await options.saveIncoming(options.raw);
  await options.check(receipt.profileId); // validate native identity before any import
  await options.store.importData(incoming); // merge only; never clear the destination
  if (incoming.settings !== undefined) options.storage.setItem("vr-settings", incoming.settings);
  await attachBackedUpProfile(receipt.profileId, options.storage, options.anchor, options.check);
}
