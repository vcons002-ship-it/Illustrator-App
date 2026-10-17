/** A restore must win over debounced, in-flight encrypted, and pagehide saves.
 * The restored raw value is retained until reload hydrates it in the new page. */
export function createSettingsPersistence(storage: Pick<Storage, "setItem">) {
  let restoring = false;
  return {
    async save(encode: () => Promise<string>): Promise<void> {
      if (restoring) return;
      const raw = await encode();
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
