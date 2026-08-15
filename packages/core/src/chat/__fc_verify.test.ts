import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildBuddySystemPrompt, BUDDY_TOOL_NAMES } from "./buddy-tools.js";
import { skillsIndexBlock } from "./skills.js";
import { withBuiltinSkills } from "./builtin-skills.js";
import { ALWAYS_ON_TOOLS, TOOLSETS } from "./toolsets.js";

const OUT = "/tmp/claude-0/-home-user-Illustrator-App/74ccdcc8-d683-5294-b24f-88916a6a52b6/scratchpad/fc";
const FULL = {
  persona: "default" as const,
  library: [],
  now: "Sunday, June 15, 2026, 4:58 PM",
  canSearchFiles: true, canRunCommands: true, canAutonomousWorkspace: true,
  canGenerateVideo: true, canWolfram: true, canGithub: true, canDelegateCoding: true,
  canDocuments: true, canSpreadsheets: true, canAppSettings: true, canBooks: true,
};
const build = (extra: Record<string, unknown> = {}) =>
  buildBuddySystemPrompt({ ...FULL, ...extra } as never);
const tok = (s: string) => Math.round(s.length / 4);

describe("fc", () => {
  it("dumps", () => {
    const asked = buildBuddySystemPrompt({ persona: "assistant", library: [], loadedToolsets: [] } as never);
    const skills = skillsIndexBlock(withBuiltinSkills([]));
    const budgetLean = build({ loadedToolsets: [] });
    const full = build();
    writeFileSync(`${OUT}/asked.txt`, asked);
    writeFileSync(`${OUT}/skills.txt`, skills);
    writeFileSync(`${OUT}/budget_lean.txt`, budgetLean);
    writeFileSync(`${OUT}/full.txt`, full);
    const budgetCombined = `${budgetLean}\n\n${skills}`;
    writeFileSync(`${OUT}/budget_combined.txt`, budgetCombined);
    const rep = {
      asked_chars: asked.length, asked_tok: tok(asked),
      asked_sha256_12: createHash("sha256").update(asked).digest("hex").slice(0, 12),
      asked_nonempty_lines: asked.split("\n").filter((l) => l.trim()).length,
      asked_total_lines: asked.split("\n").length,
      skills_chars: skills.length, skills_tok: tok(skills),
      asked_plus_skills_chars: asked.length + 2 + skills.length,
      asked_plus_skills_tok: tok(`${asked}\n\n${skills}`),
      budgetLean_chars: budgetLean.length, budgetLean_tok: tok(budgetLean),
      budgetCombined_chars: budgetCombined.length, budgetCombined_tok: tok(budgetCombined),
      spare: 5800 - tok(budgetCombined),
      full_chars: full.length, full_tok: tok(full),
      deferral_removes_pct: (1 - tok(budgetCombined) / tok(full)) * 100,
      BUDDY_TOOL_NAMES: BUDDY_TOOL_NAMES.length,
      ALWAYS_ON_TOOLS: ALWAYS_ON_TOOLS.length,
      TOOLSETS: TOOLSETS.length,
    };
    writeFileSync(`${OUT}/report.json`, JSON.stringify(rep, null, 2));
    console.log(JSON.stringify(rep, null, 2));
  });
});
