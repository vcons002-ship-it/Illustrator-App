import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../storage/store.js";
import { BUILTIN_SKILLS, withBuiltinSkills } from "./builtin-skills.js";
import {
  MAX_SKILL_DESC_CHARS,
  MAX_SKILL_NAME_CHARS,
  findSkill,
  forgetSkill,
  loadSkills,
  readSkillBody,
  saveSkill,
  skillsIndexBlock,
  touchSkill,
  type Skill,
} from "./skills.js";

const mk = (name: string, description = "d", body = "b"): Skill => ({ name, description, body, at: 1 });

describe("BUILTIN_SKILLS", () => {
  it("ships the two native-control playbooks, within the index's field limits", () => {
    expect(BUILTIN_SKILLS.map((s) => s.name)).toEqual(["control-open-programs", "office-documents"]);
    for (const s of BUILTIN_SKILLS) {
      expect(s.name.length).toBeLessThanOrEqual(MAX_SKILL_NAME_CHARS);
      // The description is the ONLY text the model sees before deciding to load the body, so it has
      // to fit the same cap a saved skill does or it would be silently truncated in the index.
      expect(s.description.length).toBeLessThanOrEqual(MAX_SKILL_DESC_CHARS);
      expect(s.body.length).toBeGreaterThan(200);
      expect(s.at).toBe(0); // never sorts as newer than something the reader wrote
    }
  });

  it("tells the model how to actually run the script, not just what to write", () => {
    const control = BUILTIN_SKILLS[0]!.body;
    const office = BUILTIN_SKILLS[1]!.body;
    // Both need the write-a-.ps1-then-run-it route: `powershell -Command "..."` through `cmd /C`
    // mangles multi-line script, which is the usual reason this looks like it doesn't work.
    for (const body of [control, office]) {
      expect(body).toContain("write_file");
      expect(body).toContain("-ExecutionPolicy Bypass -File");
    }
    expect(control).toContain("SendKeys");
    expect(control).toContain("AppActivate");
    expect(control).toContain("screenshot"); // acting is blind without looking after
    expect(office).toContain("GetActiveObject"); // the live document, not a second instance
    expect(office).toContain("READ BEFORE YOU WRITE");
  });
});

describe("withBuiltinSkills", () => {
  it("appends the built-ins after the reader's own skills", () => {
    const merged = withBuiltinSkills([mk("mine")]);
    expect(merged.map((s) => s.name)).toEqual(["mine", "control-open-programs", "office-documents"]);
  });

  it("lets a stored skill of the same name WIN (case/space-insensitively)", () => {
    const merged = withBuiltinSkills([mk("  Office-Documents  ", "mine", "my steps")]);
    expect(merged.filter((s) => s.name.trim().toLowerCase() === "office-documents")).toHaveLength(1);
    expect(readSkillBody(merged, "office-documents")).toBe("my steps");
  });

  it("is pure — it never mutates or adopts the caller's array", () => {
    const stored = [mk("mine")];
    const merged = withBuiltinSkills(stored);
    expect(stored).toHaveLength(1);
    expect(merged).not.toBe(stored);
  });

  it("puts both playbooks in the always-on index", () => {
    const block = skillsIndexBlock(withBuiltinSkills([]));
    expect(block).toContain("- control-open-programs — ");
    expect(block).toContain("- office-documents — ");
  });

  it("matches the way the model would actually ask for them", () => {
    const merged = withBuiltinSkills([]);
    expect(findSkill(merged, "office-documents")?.name).toBe("office-documents");
    expect(findSkill(merged, "excel")?.name).toBe("office-documents"); // via description
    expect(findSkill(merged, "control-open-programs")?.name).toBe("control-open-programs");
  });
});

describe("built-ins through the store", () => {
  it("read_skill (touchSkill) resolves a built-in without persisting a copy of it", async () => {
    const store = new InMemoryStore();
    const hit = await touchSkill(store, "office-documents");
    expect(hit?.name).toBe("office-documents");
    expect(hit?.body).toContain("GetActiveObject");
    // Nothing was written: a built-in that landed in the store could then be `forget`ten, or go
    // stale against the shipped copy.
    expect(await loadSkills(store)).toEqual([]);
  });

  it("cannot be forgotten", async () => {
    const store = new InMemoryStore();
    await touchSkill(store, "control-open-programs");
    await expect(forgetSkill(store, "control-open-programs")).rejects.toThrow(/no skill name contains/);
    expect(withBuiltinSkills(await loadSkills(store)).map((s) => s.name)).toContain("control-open-programs");
  });

  it("a reader's own skill of the same name shadows the built-in everywhere", async () => {
    const store = new InMemoryStore();
    await saveSkill(store, { name: "office-documents", description: "mine", body: "my own steps" });
    const hit = await touchSkill(store, "office-documents");
    expect(hit?.body).toBe("my own steps");
    // …and touching it still records reuse on the STORED one.
    expect((await loadSkills(store))[0]!.useCount).toBe(1);
  });
});
