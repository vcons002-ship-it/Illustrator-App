/** A restore must win over debounced, in-flight encrypted, and pagehide saves.
 * The restored raw value is retained until reload hydrates it in the new page. */
export function createSettingsPersistence(storage: Pick<Storage, "setItem">) {
  let restoring = false;
  let retainedSecrets: unknown;
  return {
    preserveEncryptedSecrets(value: unknown): void {
      retainedSecrets = value;
    },
    async save(encode: () => Promise<string>): Promise<void> {
      if (restoring) return;
      let raw = await encode();
      if (retainedSecrets) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // An inaccessible device vault must not turn a normal settings autosave into key deletion.
        if (!parsed.keysEnc) raw = JSON.stringify({ ...parsed, keysEnc: retainedSecrets });
        else retainedSecrets = undefined; // User explicitly supplied replacement keys.
      }
      if (!restoring) storage.setItem("vr-settings", raw);
    },
    restore(raw: string): void {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Backup settings must be an object.");
      restoring = true;
      try {
        storage.setItem("vr-settings", raw);
      } catch (error) {
        restoring = false;
        throw error;
      }
    },
  };
}

export type SettingsPersistence = ReturnType<typeof createSettingsPersistence>;
