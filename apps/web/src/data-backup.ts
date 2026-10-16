import type { StoreBackup } from "@visual-reader/core";

/** Non-secret provenance makes an empty/different launch distinguishable from data loss. */
export function dataBackupPayload(data: StoreBackup, settings: string | undefined, origin: string) {
  return { ...data, ...(settings ? { settings } : {}), source: { origin },
    counts: Object.fromEntries(Object.entries(data.stores).map(([name, rows]) => [name, rows.length])) };
}

export function updateBackupFilename(now = new Date()): string {
  return `visual-reader-pre-update-${now.toISOString().replace(/[:.]/g, "-")}.json`;
}
