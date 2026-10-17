import { useEffect, useState, type ReactNode } from "react";
import { checkDesktopSession, isDesktop } from "./runtime.js";
import { verifyDesktopProfile } from "./desktop-profile.js";

/** Do not mount App (and its autosaves) inside an unexpected WebView data profile. */
export function DesktopSessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState(isDesktop ? "checking" : "ready");
  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    void (async () => {
      try {
        await verifyDesktopProfile(localStorage, checkDesktopSession, () => crypto.randomUUID());
        if (!cancelled) setState("ready");
      } catch (error) {
        if (!cancelled) setState(String(error));
      }
    })();
    return () => { cancelled = true; };
  }, []);
  if (state === "ready") return children;
  return <main style={{ padding: 32, maxWidth: 800 }} role="alert">
    <h1>{state === "checking" ? "Checking saved desktop session…" : "Saved-data profile needs attention"}</h1>
    {state !== "checking" && <p>{state}</p>}
  </main>;
}
