import type { Character, VisualBible } from "../../types/bible.js";
import { emptyAppearance } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";
import type { EntityExtractionInput, LLMProvider } from "./llm-provider.js";

/**
 * Deterministic, network-free LLM provider for tests and keyless demos.
 *
 * Extraction is a naive heuristic: capitalised multi-letter tokens that recur
 * are treated as character names. It is intentionally simple — its job is to
 * exercise the pipeline, not to be accurate.
 */
export class MockLLMProvider implements LLMProvider {
  readonly id = "mock";

  async extractEntities(input: EntityExtractionInput): Promise<VisualBible> {
    const counts = new Map<string, number>();
    const wordRe = /\b([A-Z][a-z]{2,})\b/g;
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(input.chapterText)) !== null) {
      const name = m[1]!;
      if (STOPWORDS.has(name)) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    const bible: VisualBible = {
      ...input.existing,
      characters: [...input.existing.characters],
      storyboard: [...(input.existing.storyboard ?? [])],
      glossary: [...(input.existing.glossary ?? [])],
      processedChapters: [...input.existing.processedChapters],
    };
    const known = new Set(bible.characters.map((c) => c.name));

    // Deterministic storyboard scene: chapter summary + first sentence as the moment.
    const snippet = input.chapterText.replace(/\s+/g, " ").trim();
    const summary = snippet.slice(0, 160);
    const keyMoment = (snippet.split(/(?<=[.!?])\s/)[0] ?? summary).slice(0, 160);
    bible.storyboard = [
      ...bible.storyboard.filter((s) => s.chapterIndex !== input.chapterIndex),
      { chapterIndex: input.chapterIndex, summary, keyMoment },
    ].sort((a, b) => a.chapterIndex - b.chapterIndex);

    for (const [name, count] of counts) {
      if (count < 2 || known.has(name)) continue;
      const character: Character = {
        id: `char-${slug(name)}`,
        name,
        aliases: [],
        appearance: emptyAppearance(),
        persistentTraits: ["consistent appearance"],
        clothing: [],
        anchor: { seed: deterministicSeed(name) },
        firstSeenChapter: input.chapterIndex,
      };
      bible.characters.push(character);
      known.add(name);
    }

    if (!bible.processedChapters.includes(input.chapterIndex)) {
      bible.processedChapters.push(input.chapterIndex);
    }
    return bible;
  }

  async buildImagePrompt(request: VisualRequest, bible: VisualBible): Promise<string> {
    const chars = bible.characters.filter((c) => request.characterIds.includes(c.id));
    const charDesc = chars
      .map((c) => `${c.name} (${c.persistentTraits.join(", ")})`)
      .join("; ");
    const scene = (bible.storyboard ?? []).find((s) => s.chapterIndex === request.chapterIndex);
    const snippet = request.sourceText.slice(0, 160).replace(/\s+/g, " ").trim();
    return [
      "Illustration of a book scene.",
      charDesc ? `Characters: ${charDesc}.` : "",
      scene?.keyMoment ? `Key moment: ${scene.keyMoment}` : `Scene: ${snippet}`,
    ]
      .filter(Boolean)
      .join(" ");
  }
}

/** FNV-1a hash → stable per-name seed. */
export function deterministicSeed(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const STOPWORDS = new Set([
  "The", "And", "But", "She", "His", "Her", "Him", "Was", "Had", "Then", "When",
  "They", "Their", "There", "This", "That", "With", "From", "What", "Who", "Why",
]);
