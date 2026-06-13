import { useEffect, useState } from "react";
import type { ImageResult } from "@visual-reader/core";

/**
 * A render result as the UI displays it: the engine's raw `ArrayBuffer` image,
 * or a `Blob` the host converted on receipt. Hosts SHOULD convert: a Blob's data
 * is browser-managed (spillable out of the JS heap), so keeping every rendered
 * page of a long book doesn't pin hundreds of MB of ArrayBuffers in memory.
 * `ImageResult` stays assignable, so hosts without the conversion work as-is.
 */
export type DisplayImage =
  | { bytes: ArrayBuffer; mimeType: string }
  | { blob: Blob; mimeType: string };
export type DisplayResult = Omit<ImageResult, "image"> & {
  image?: DisplayImage;
  /** Bytes were dropped to bound memory (a long book), but the image IS rendered and
   * cached on disk — the host reloads it from IndexedDB when the reader returns. The
   * status stays "ready"; this flags that the heavy bytes just aren't resident. */
  evicted?: boolean;
};

/**
 * Turn a ready result's image into an object URL, revoking it on change.
 * Shared by the single-image `ImagePanel` and the multi-panel `PanelGrid` so the
 * blob lifecycle is identical in both. Returns undefined while there's nothing to show.
 */
export function useObjectUrl(result: DisplayResult | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);
  const image = result?.image;
  useEffect(() => {
    if (!image) {
      setUrl(undefined);
      return;
    }
    const blob = "blob" in image ? image.blob : new Blob([image.bytes], { type: image.mimeType });
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image]);
  return url;
}
