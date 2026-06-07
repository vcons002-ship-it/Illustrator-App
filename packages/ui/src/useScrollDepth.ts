import { useEffect, useRef, useState } from "react";

/**
 * Scroll-depth tracking (spec Module 3). Watches paragraph elements with an
 * IntersectionObserver and reports which paragraph is active (in the top ~30%
 * of the viewport) plus the set of paragraphs the reader has scrolled past.
 *
 * The passed-set drives spoiler reveal; the active paragraph drives which page
 * the engine treats as "current" for the predictive buffer.
 */
export interface ScrollDepth {
  /** Ref callback to attach to each paragraph element. */
  registerParagraph: (id: string) => (el: HTMLElement | null) => void;
  activeParagraphId: string | undefined;
  passedParagraphIds: ReadonlySet<string>;
}

export function useScrollDepth(): ScrollDepth {
  const elements = useRef(new Map<string, HTMLElement>());
  const observer = useRef<IntersectionObserver | null>(null);
  const [activeParagraphId, setActive] = useState<string | undefined>(undefined);
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

  const registerParagraph = (id: string) => (el: HTMLElement | null) => {
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

  return { registerParagraph, activeParagraphId, passedParagraphIds };
}
