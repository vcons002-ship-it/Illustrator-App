import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Scroll-depth tracking (spec Module 3). Watches paragraph elements with an
 * IntersectionObserver and reports which paragraph is active (in the top ~30%
 * of the viewport) plus the set of paragraphs the reader has scrolled past.
 *
 * The passed-set drives spoiler reveal; the active paragraph drives which page
 * the engine treats as "current" for the predictive buffer.
 */
/** Active band line = top 30% of the viewport (matches the observer rootMargin). */
const ACTIVE_BAND = 0.3;

/**
 * Progress is quantized to this step before it becomes state. The raw ratio
 * differs on essentially every scroll frame, and this hook sits at the app
 * root — unquantized, every frame re-rendered the whole reader. A ~1.5% step
 * is invisible (BloomTransition eases toward the target anyway) but lets
 * React's same-value bailout skip most frames.
 */
const PROGRESS_STEP = 1 / 64;

export interface ScrollDepth {
  /** Ref callback to attach to each paragraph element. */
  registerParagraph: (id: string) => (el: HTMLElement | null) => void;
  activeParagraphId: string | undefined;
  /** Continuous 0..1 position of the reader through the active paragraph (smooth bloom). */
  activeParagraphProgress: number;
  passedParagraphIds: ReadonlySet<string>;
}

export function useScrollDepth(): ScrollDepth {
  const elements = useRef(new Map<string, HTMLElement>());
  const observer = useRef<IntersectionObserver | null>(null);
  const [activeParagraphId, setActive] = useState<string | undefined>(undefined);
  const [activeParagraphProgress, setProgress] = useState(0);
  const [passedParagraphIds, setPassed] = useState<Set<string>>(new Set());

  useEffect(() => {
    observer.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-paragraph-id");
          if (!id) continue;
          if (entry.isIntersecting) {
            setActive(id);
          } else if (entry.boundingClientRect.top < 0) {
            // Scrolled above the viewport → reader has passed it.
            setPassed((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
          }
        }
      },
      // Active band = top 30% of the viewport.
      { rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );
    for (const el of elements.current.values()) observer.current.observe(el);
    return () => observer.current?.disconnect();
  }, []);

  // Continuous progress through the active paragraph: how far its box has scrolled
  // past the active-band line. rAF-throttled so it's cheap during scroll.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const el = activeParagraphId ? elements.current.get(activeParagraphId) : undefined;
      if (!el) {
        setProgress(0);
        return;
      }
      const rect = el.getBoundingClientRect();
      const bandLine = window.innerHeight * ACTIVE_BAND;
      const height = rect.height || 1;
      const raw = Math.max(0, Math.min(1, (bandLine - rect.top) / height));
      setProgress(Math.round(raw / PROGRESS_STEP) * PROGRESS_STEP);
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [activeParagraphId]);

  // One STABLE ref callback per paragraph id. A fresh callback per render makes
  // React detach + reattach every paragraph's ref (and the observer) on every
  // render of the consumer — for a whole book's paragraphs. Cached, the callbacks
  // only fire on real mount/unmount.
  const refCallbacks = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const registerParagraph = useCallback((id: string) => {
    let cb = refCallbacks.current.get(id);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        const existing = elements.current.get(id);
        if (existing && observer.current) observer.current.unobserve(existing);
        if (el) {
          el.setAttribute("data-paragraph-id", id);
          elements.current.set(id, el);
          observer.current?.observe(el);
        } else {
          elements.current.delete(id);
        }
      };
      refCallbacks.current.set(id, cb);
    }
    return cb;
  }, []);

  return { registerParagraph, activeParagraphId, activeParagraphProgress, passedParagraphIds };
}
