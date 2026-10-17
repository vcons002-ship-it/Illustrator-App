export async function verifyDesktopProfile(
  storage: Pick<Storage, "getItem" | "setItem">,
  check: (profileId: string) => Promise<void>,
  createId: () => string,
): Promise<void> {
  const key = "vr-desktop-profile-id";
  const profileId = storage.getItem(key) ?? createId();
  // Write before invoking: StrictMode and overlapping bootstrap effects must use one identity.
  storage.setItem(key, profileId);
  await check(profileId);
}
