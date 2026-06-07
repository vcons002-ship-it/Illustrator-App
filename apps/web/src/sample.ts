import { segmentBook } from "@visual-reader/epub";
import type { BookSource } from "@visual-reader/core";

/**
 * A short original sample so the app is usable without uploading an EPUB.
 * "Aria" and "the bridge" recur, so even the heuristic mock LLM populates a
 * small Visual Bible and the continuity flow is visible end to end.
 */
const SAMPLE_TEXT = `Aria pulled her red coat tight as she stepped onto the bridge of the derelict ship. Dust hung in the cold air, catching the light of a single failing lamp.

The bridge was cramped, its consoles long dark. Aria ran a gloved hand across the nearest panel and, to her surprise, a row of indicators blinked awake beneath the grime.

A sound behind her. Aria turned, silver hair falling across her face, and saw the silhouette of Corin in the hatchway, taller than she remembered, a long scar bright along his jaw.

"You came," Corin said. He held something wrapped in cloth — a hidden knife, though Aria would not learn that until later.

Together they worked at the consoles, coaxing the old ship back toward life. Outside the viewport, the dead stars wheeled slowly, indifferent to the two small figures on the bridge.`;

export function loadSampleBook(): BookSource {
  return segmentBook(
    { id: "sample-derelict", title: "The Derelict", author: "Visual Reader Demo" },
    [{ title: "Chapter One: The Bridge", text: SAMPLE_TEXT }],
    { wordsPerPage: 60 },
  );
}
