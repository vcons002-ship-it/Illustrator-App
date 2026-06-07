import type { ReactNode } from "react";
import type { SpoilerEntity } from "@visual-reader/core";
import { shouldRevealImage } from "@visual-reader/core";

/**
 * "Fog of War" spoiler gate (spec Module 3). Keeps an image under a heavy
 * backdrop blur until the reader's scroll depth has passed every spoiler the
 * image depicts. Reveal logic is the shared, unit-tested `shouldRevealImage`.
 */
export interface SpoilerGateProps {
  imageSpoilerIds: string[];
  spoilers: SpoilerEntity[];
  passedParagraphIds: ReadonlySet<string>;
  children: ReactNode;
}

export function SpoilerGate({
  imageSpoilerIds,
  spoilers,
  passedParagraphIds,
  children,
}: SpoilerGateProps) {
  const revealed = shouldRevealImage(imageSpoilerIds, spoilers, passedParagraphIds);
  return (
    <div style={{ position: "relative", overflow: "hidden", borderRadius: 8 }}>
      <div
        style={{
          filter: revealed ? "none" : "blur(24px)",
          transform: revealed ? "none" : "scale(1.05)",
          transition: "filter 600ms ease, transform 600ms ease",
        }}
      >
        {children}
      </div>
      {!revealed && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.25)",
            color: "rgba(255,255,255,0.9)",
            fontSize: 13,
            letterSpacing: 0.4,
            pointerEvents: "none",
          }}
        >
          keep reading to reveal…
        </div>
      )}
    </div>
  );
}
