import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../storage/store.js";
import {
  MAX_SKILLS,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_NAME_CHARS,
  findSkill,
  forgetSkill,
  loadSkills,
  normalizeSkill,
  readSkillBody,
  saveSkill,
  skillsIndexBlock,
  touchSkill,
  type Skill,
} from "./skills.js";

describe("touchSkill (reuse tracking)", () => {
  it("bumps useCount + lastUsedAt on a match, keeps reuse stats when refined", async () => {
    const store = new InMemoryStore();
    await saveSkill(store, { name: "do-x", description: "when x", body: "steps" });
    const hit = await touchSkill(store, "do-x");
    expect(hit?.name).toBe("do-x");
    let saved = (await loadSkills(store)).find((s) => s.name === "do-x")!;
    expect(saved.useCount).toBe(1);
    expect(saved.lastUsedAt).toBeGreaterThan(0);
    await touchSkill(store, "do-x");
    // Refining the skill in place preserves the earned use count.
    await saveSkill(store, { name: "do-x", description: "when x", body: "better steps" });
    saved = (await loadSkills(store)).find((s) => s.name === "do-x")!;
    expect(saved.useCount).toBe(2);
    expect(saved.body).toBe("better steps");
    expect(await touchSkill(store, "nope")).toBeUndefined();
  });
});

const mk = (name: string, description = "", body = "steps"): Skill => ({ name, description, body, at: 1 });

describe("skills store", () => {
  it("saves and loads skills through the store", async () => {
    const store = new InMemoryStore();
    expect(await loadSkills(store)).toEqual([]);
    await saveSkill(store, { name: "react-component", description: "scaffold a React component", body: "1. …" });
    const skills = await loadSkills(store);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("react-component");
    expect(skills[0]!.body).toBe("1. …");
    expect(typeof skills[0]!.at).toBe("number");
  });

  it("re-saving the same name REPLACES it (refine in place, no duplicate)", async () => {
    const store = new InMemoryStore();
    await saveSkill(store, { name: "Deploy", body: "old steps" });
    await saveSkill(store, { name: "deploy", body: "better steps" });
    const skills = await loadSkills(store);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.body).toBe("better steps");
  });

  it("trims + caps fields and rejects an empty name or body", async () => {
    const store = new InMemoryStore();
    const skills = await saveSkill(store, {
      name: `  ${"x".repeat(MAX_SKILL_NAME_CHARS + 20)}  `,
      body: "y".repeat(MAX_SKILL_BODY_CHARS + 100),
    });
    expect(skills[0]!.name).toHaveLength(MAX_SKILL_NAME_CHARS);
    expect(skills[0]!.body).toHaveLength(MAX_SKILL_BODY_CHARS);
    await expect(saveSkill(store, { name: "  ", body: "x" })).rejects.toThrow(/needs a name and a body/);
    await expect(saveSkill(store, { name: "x", body: "  " })).rejects.toThrow(/needs a name and a body/);
  });

  it("evicts the oldest skill past the cap", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < MAX_SKILLS + 2; i++) await saveSkill(store, { name: `skill-${i}`, body: "b" });
    const skills = await loadSkills(store);
    expect(skills).toHaveLength(MAX_SKILLS);
    expect(skills[0]!.name).toBe("skill-2"); // 0,1 evicted
  });

  it("forgets by case-insensitive name substring and throws when nothing matches", async () => {
    const store = new InMemoryStore();
    await saveSkill(store, { name: "deploy-web", body: "b" });
    await saveSkill(store, { name: "make-chart", body: "b" });
    const kept = await forgetSkill(store, "DEPLOY");
    expect(kept.map((s) => s.name)).toEqual(["make-chart"]);
    await expect(forgetSkill(store, "nope")).rejects.toThrow(/no skill name contains/);
  });

  it("survives a corrupt stored memo (treats it as empty)", async () => {
    const store = new InMemoryStore();
    await store.putMemo("reader-skills", "{not json");
    expect(await loadSkills(store)).toEqual([]);
  });
});

describe("normalizeSkill", () => {
  it("collapses whitespace and returns undefined without a name/body", () => {
    expect(normalizeSkill({ name: "  a   b ", body: "x" })?.name).toBe("a b");
    expect(normalizeSkill({ name: "", body: "x" })).toBeUndefined();
    expect(normalizeSkill({ name: "a", body: "   " })).toBeUndefined();
  });
});

describe("findSkill / readSkillBody", () => {
  const skills = [mk("react-component", "scaffold a component", "RC body"), mk("deploy", "ship it", "DEPLOY body")];

  it("matches exact name, then loose name, then description", () => {
    expect(findSkill(skills, "deploy")?.name).toBe("deploy");
    expect(findSkill(skills, "react")?.name).toBe("react-component"); // loose
    expect(findSkill(skills, "ship")?.name).toBe("deploy"); // description
    expect(findSkill(skills, "nothing")).toBeUndefined();
  });

  it("readSkillBody returns the body or '' when none match", () => {
    expect(readSkillBody(skills, "react-component")).toBe("RC body");
    expect(readSkillBody(skills, "absent")).toBe("");
  });
});

describe("skillsIndexBlock", () => {
  it("is empty with no skills and lists name — description otherwise", () => {
    expect(skillsIndexBlock([])).toBe("");
    const block = skillsIndexBlock([mk("deploy", "ship the site")]);
    expect(block).toContain("SKILLS");
    expect(block).toContain("read_skill");
    expect(block).toContain("- deploy — ship the site");
  });
});
