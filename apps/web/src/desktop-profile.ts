export const DESKTOP_PROFILE_MEMO = "desktop-profile-id:v1";
export interface ProfileAnchor {
  read(): Promise<string | undefined>;
  write(id: string): Promise<void>;
}

export async function verifyDesktopProfile(
  storage: Pick<Storage, "getItem" | "setItem">,
  check: (profileId: string) => Promise<void>,
  createId: () => string,
  anchor?: ProfileAnchor,
): Promise<void> {
  const key = "vr-desktop-profile-id";
  const localId = storage.getItem(key) ?? createId();
  // Write before invoking: StrictMode and overlapping bootstrap effects must use one identity.
  storage.setItem(key, localId);
  // The anchor lives with the chats, unlike Local Storage which can be cleared independently.
  // Never fall back to a local marker when an existing database anchor is rejected.
  const profileId = (await anchor?.read()) ?? localId;
  await check(profileId);
  await anchor?.write(profileId);
  storage.setItem(key, profileId);
}

/** Explicit recovery only, after the native side has saved the current database and metadata. */
export async function attachBackedUpProfile(
  profileId: string, storage: Pick<Storage, "setItem">, anchor: ProfileAnchor,
  check: (id: string) => Promise<void>,
): Promise<void> {
  await check(profileId); // do not change the native expected identity or the phone credential
  await anchor.write(profileId);
  storage.setItem("vr-desktop-profile-id", profileId);
}
