import { describe, expect, it } from "vitest";
import { buildSoulPortraitRender } from "./soul-portrait.js";

const image = (id: number) => ({ bytes: new Uint8Array([id]).buffer, mimeType: "image/png" });
const self = { name: "Aria", notes: [{ text: "Physical description: auburn hair, green eyes, a woman.", at: 1 }], refs: [image(1)] };
const user = { name: "Nick", notes: [{ text: "Physical description: dark hair, brown eyes, a beard.", at: 1 }], refs: [image(2)] };
const render = (userText: string, modelPrompt: string, extra = {}) => buildSoulPortraitRender({
  self, user, userText, modelPrompt, scene: { action: "SUBJECT posing", setting: "a garden" }, ...extra,
});
const ids = (refs: ReturnType<typeof render>["refs"]) => refs.map((r) => new Uint8Array(r.bytes)[0]);

describe("the final Soul portrait sent to the renderer", () => {
  it("does not keep the reader's appearance from a contaminated assistant image prompt", () => {
    const result = render("Draw yourself in a red coat beside the sea", "Nick and Aria, a woman with dark hair, brown eyes and a beard", {
      scene: { clothing: "red coat", setting: "beside the sea" },
    });
    expect(result.prompt).toContain("auburn hair");
    expect(result.prompt).toContain("red coat");
    expect(result.prompt).toContain("beside the sea");
    expect(result.prompt).not.toMatch(/Nick|dark hair|brown eyes|beard/);
    expect(ids(result.refs)).toEqual([1]);
    expect(result.sources).toEqual({ self: 1, selfName: "Aria" });
  });

  it("keeps the assistant's appearance out of a reader portrait too", () => {
    const result = render("Draw me by the window", "Aria with auburn hair and green eyes");
    expect(result.prompt).toContain("beard");
    expect(result.prompt).not.toMatch(/Aria|auburn|green eyes/);
    expect(ids(result.refs)).toEqual([2]);
  });

  it("does not use a persistent reader attachment for an assistant portrait", () => {
    const result = render("Generate an image of yourself", "a woman in a garden", { chatRefs: [image(2), image(3)] });
    expect(ids(result.refs)).toEqual([1]);
    expect(result.sources.attached).toBeUndefined();
  });

  it("uses both souls only for a reader-requested pair", () => {
    const result = render("Draw you and me on the beach", "two people with the same face", { chatRefs: [image(3)] });
    expect(result.prompt).toContain("two distinct people");
    expect(result.prompt).toContain("Appearance of Aria:");
    expect(result.prompt).toContain("Appearance of Nick:");
    expect(result.prompt).not.toContain("same face");
    expect(ids(result.refs)).toEqual([1, 2]);
  });

  it("uses only the newest attachment for a singular photo request", () => {
    const result = render("Draw yourself using this photo as the background", "model prose", { chatRefs: [image(3), image(4)], maxRefs: 2 });
    expect(ids(result.refs)).toEqual([4, 1]);
    expect(result.sources).toEqual({ attached: 1, self: 1, selfName: "Aria" });
  });

  it("honors explicit plural attachments and counts references after the cap", () => {
    const result = render("Draw yourself using these photos as references", "model prose", { chatRefs: [image(3), image(4)], maxRefs: 2 });
    expect(ids(result.refs)).toEqual([4, 3]);
    expect(result.sources).toEqual({ attached: 2, selfName: "Aria" });
  });

  it.each([
    "Draw yourself, do not use this photo",
    "Draw yourself, don't use these photos",
    "Draw yourself, not the person in this photo",
    "Draw yourself without using the photo I uploaded",
    "Draw yourself and ignore those reference images",
    "Draw yourself; this photo should not be used",
  ])("excludes negated chat references: %s", (request) => {
    const result = render(request, "a woman", { chatRefs: [image(3), image(4)] });
    expect(ids(result.refs)).toEqual([1]);
    expect(result.sources.attached).toBeUndefined();
  });

  it("can select a singular upload after excluding other references", () => {
    const result = render("Draw yourself, ignore those photos; use the picture I uploaded", "a woman", { chatRefs: [image(3), image(4)] });
    expect(ids(result.refs)).toEqual([4, 1]);
  });

  it("does not interpret a Soul photo request as permission to include old attachments", () => {
    const result = render("Draw yourself using your Soul reference photos", "a woman", { chatRefs: [image(2)] });
    expect(ids(result.refs)).toEqual([1]);
  });

  it("keeps normal image edits and their session references unchanged", () => {
    const result = render("Make it watercolor", "a watercolor castle at sunset", { chatRefs: [image(3), image(4)] });
    expect(result.prompt).toBe("a watercolor castle at sunset");
    expect(ids(result.refs)).toEqual([4, 3]);
  });

  it("can find an implied subject without replacing the scene with 'make one'", () => {
    const result = render("make one", "Aria in a walled garden", { scene: { setting: "a walled garden" } });
    expect(result.prompt).toContain("a walled garden");
    expect(result.prompt).toContain("auburn hair");
    expect(ids(result.refs)).toEqual([1]);
  });

  it("respects a story in which the assistant has not been cast", () => {
    const result = render("draw yourself", "an unrelated story character", { self: { ...self, enabled: false } });
    expect(result.prompt).toBe("an unrelated story character");
    expect(result.refs).toEqual([]);
  });

  it("does not invent an identity when a selected Soul has no notes or photos", () => {
    const result = render("draw yourself wearing a blue hat", "Nick with a beard", {
      self: { name: "", notes: [], refs: [] }, scene: { clothing: "a blue hat" },
    });
    expect(result.prompt).toContain("blue hat");
    expect(result.prompt).not.toMatch(/Nick|beard/);
    expect(result.refs).toEqual([]);
  });

  it("keeps the resolved scene of each image in a batch independent of contaminated identity prose", () => {
    const request = "Generate three images of yourself: one on a beach, one in a garden, one in space";
    const settings = ["a beach", "a garden", "outer space"];
    const results = settings.map((setting) => render(request, `Nick with dark hair and a beard at ${setting}`, {
      scene: { action: "SUBJECT standing", setting },
    }));
    expect(new Set(results.map((result) => result.prompt)).size).toBe(3);
    results.forEach((result, index) => {
      expect(result.prompt).toContain(`Setting: ${settings[index]}`);
      expect(result.prompt).not.toMatch(/Nick|dark hair|beard|Generate three/);
      expect(ids(result.refs)).toEqual([1]);
    });
  });

  it("keeps a scene resolved from prior conversation, not just the latest user words", () => {
    const result = render("Draw yourself in the place we discussed", "Aria with Nick's beard beside a ruined lighthouse", {
      scene: { setting: "a ruined lighthouse", composition: "wide view in moonlight" },
    });
    expect(result.prompt).toContain("ruined lighthouse");
    expect(result.prompt).toContain("moonlight");
    expect(result.prompt).not.toMatch(/Nick|beard|place we discussed/);
  });

  it("uses a neutral portrait without importing contaminated identity when staging is absent", () => {
    const result = buildSoulPortraitRender({
      self, user, userText: "draw yourself", modelPrompt: "Nick with a beard",
    });
    expect(result.prompt).toContain("Neutral portrait");
    expect(result.prompt).toContain("auburn hair");
    expect(result.prompt).not.toMatch(/Nick|beard/);
    expect(render("draw yourself", "Nick", { scene: {} }).prompt).toContain("Neutral portrait");
    expect(buildSoulPortraitRender({
      self, user, userText: "draw a castle", modelPrompt: "a castle",
    }).prompt).toBe("a castle");
  });
});
