import { useEffect, useState } from "react";
import type { ImageResult } from "@visual-reader/core";

/**
 * Turn a ready result's image bytes into an object URL, revoking it on change.
 * Shared by the single-image `ImagePanel` and the multi-panel `PanelGrid` so the
 * blob lifecycle is identical in both. Returns undefined while there's nothing to show.
 */
export function useObjectUrl(result: ImageResult | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);
  const image = result?.image;
  useEffect(() => {
    if (!image) {
      setUrl(undefined);
      return;
    }
    const objectUrl = URL.createObjectURL(new Blob([image.bytes], { type: image.mimeType }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image]);
  return url;
}
