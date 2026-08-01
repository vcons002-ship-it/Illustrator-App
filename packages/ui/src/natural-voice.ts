/**
 * NATURAL VOICE — the optional open-source speech engine (Kokoro-82M, Apache-2.0), run in the page.
 *
 * The browser's own voices are whatever the operating system happens to ship, which is why the
 * feminine/masculine choice had to be inferred from names like "Google US English" and sometimes
 * couldn't be. This model states each voice's gender, so the reader's choice becomes a fact — and it
 * sounds the same on a desktop, a phone and a linked phone, because it isn't the platform's voice at
 * all.
 *
 * IT IS OPT-IN AND IT DOWNLOADS. Roughly 80MB of weights, fetched once and cached by the browser.
 * Nothing here runs until the reader turns it on, and every failure falls back to the system voice
 * OUT LOUD — a feature that quietly stops speaking is the bug this whole area started with.
 */
import { pickNaturalVoice, type VoiceGender } from "@visual-reader/core";

/** The published Kokoro build. Quantised: ~80MB rather than ~330MB, for no audible loss. */
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "q8";

export type NaturalVoiceStatus =
  | { state: "off" }
  | { state: "loading"; progress: number }
  | { state: "ready" }
  | { state: "failed"; error: string };

type Kokoro = {
  voices: Record<string, { name: string; language: string; gender: string; overallGrade?: string }>;
  generate: (text: string, opts: { voice: string }) => Promise<{ toBlob: () => Blob }>;
};

let loading: Promise<Kokoro> | undefined;
let loaded: Kokoro | undefined;

/**
 * Overall fetch progress across every file, by BYTES.
 *
 * The runtime reports progress per file — tokenizer, config, weights, voice data — each running 0 to
 * 100 of its own. Showing whichever arrived last makes the number lurch backwards several times,
 * which reads as a stuck download. Summing bytes gives one number that only goes forward. The weights
 * dominate the total, so it also reflects the actual wait.
 */
function trackProgress(onProgress?: (fraction: number) => void): (p: unknown) => void {
  const files = new Map<string, { loaded: number; total: number }>();
  return (raw: unknown) => {
    const p = raw as { file?: string; loaded?: number; total?: number };
    if (!p?.file || typeof p.total !== "number" || p.total <= 0) return;
    files.set(p.file, { loaded: Math.min(p.loaded ?? 0, p.total), total: p.total });
    let done = 0;
    let all = 0;
    for (const f of files.values()) {
      done += f.loaded;
      all += f.total;
    }
    if (all > 0) onProgress?.(Math.max(0, Math.min(1, done / all)));
  };
}

/**
 * Load the model (once per page), reporting progress.
 *
 * A failed load CLEARS the cached promise so turning it on again retries — a transient network
 * failure must not poison the feature for the rest of the session.
 */
export async function loadNaturalVoice(onProgress?: (fraction: number) => void): Promise<Kokoro> {
  if (loaded) return loaded;
  if (!loading) {
    loading = (async () => {
      // Imported dynamically so the weights-adjacent runtime is a separate chunk the app only
      // fetches when the reader has actually asked for this.
      const { KokoroTTS } = await import("kokoro-js");
      const tts = (await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: DTYPE,
        progress_callback: trackProgress(onProgress),
      })) as unknown as Kokoro;
      loaded = tts;
      return tts;
    })().catch((e) => {
      loading = undefined;
      throw e;
    });
  }
  return loading;
}

/** Whether the model is already in memory, so speaking can start without a wait. */
export function naturalVoiceReady(): boolean {
  return loaded !== undefined;
}

/**
 * Speak one passage, resolving when it has finished playing.
 *
 * Playback is an `<audio>` element rather than the Web Audio graph: it is the shorter path to the
 * same sound, and it respects the device's media controls and silent switch the way a reader
 * expects. `signal` aborts BOTH the synthesis wait and the playback, so stopping is immediate.
 */
export async function speakNaturally(
  texts: readonly string[],
  opts: { gender?: VoiceGender; lang?: string; signal?: AbortSignal },
): Promise<void> {
  const tts = await loadNaturalVoice();
  if (opts.signal?.aborted || texts.length === 0) return;
  const voice = pickNaturalVoice(tts.voices, {
    ...(opts.gender ? { gender: opts.gender } : {}),
    ...(opts.lang ? { lang: opts.lang } : {}),
  });
  if (!voice) throw new Error("the natural voice model has no voices");
  // Synthesise the NEXT piece while this one is playing.
  //
  // Generating and playing strictly in turn put a silent gap at every seam — the model takes a real
  // fraction of a second per sentence — so a paragraph came out as a stutter with a pause between
  // each phrase. Reading ahead by one hides that behind the audio already playing, which is the
  // difference between "a voice" and "a voice that keeps stopping".
  let pending: Promise<{ toBlob: () => Blob }> | undefined = tts.generate(texts[0]!, { voice });
  for (let i = 0; i < texts.length; i++) {
    const audio = await pending;
    pending = i + 1 < texts.length ? tts.generate(texts[i + 1]!, { voice }) : undefined;
    if (opts.signal?.aborted || !audio) return;
    const url = URL.createObjectURL(audio.toBlob());
    try {
      await playUrl(url, opts.signal);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** Play one clip to its end, or stop early when aborted. Never rejects on a stop. */
function playUrl(url: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = new Audio(url);
    const done = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      el.pause();
      done();
    };
    el.onended = done;
    el.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("could not play the generated audio"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void el.play().catch(() => {
      // Autoplay refused (no user gesture yet). Not an error worth failing the whole engine over —
      // the caller falls back to the system voice, which has the same requirement and the same fix.
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("the browser blocked audio playback"));
    });
  });
}
