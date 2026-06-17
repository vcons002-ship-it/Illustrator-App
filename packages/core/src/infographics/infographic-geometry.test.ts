import { describe, expect, it } from "vitest";
import { layoutFlowchart } from "./infographic-geometry.js";
import type { InfographicSpec } from "../types/bible.js";

const flow = (nodes: [string, string][], edges: [string, string][]): Extract<InfographicSpec, { kind: "flowchart" }> => ({
  kind: "flowchart",
  nodes: nodes.map(([id, label]) => ({ id, label, shape: "step" })),
  edges: edges.map(([from, to]) => ({ from, to })),
});

describe("layoutFlowchart", () => {
  it("lays nodes top-to-bottom in edge order with a straight edge between neighbours", () => {
    const out = layoutFlowchart(flow([["b", "Second"], ["a", "First"], ["c", "Third"]], [["a", "b"], ["b", "c"]]));
    // ordered from the root `a` (no incoming) downward, not input order
    expect(out.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(out.nodes[0]!.y).toBeLessThan(out.nodes[1]!.y);
    expect(out.nodes[1]!.y).toBeLessThan(out.nodes[2]!.y);
    expect(out.edges).toHaveLength(2);
    expect(out.edges[0]!.path).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/); // straight
    expect(out.height).toBeGreaterThan(out.nodes[2]!.y);
    expect(out.width).toBeGreaterThan(200);
  });

  it("routes a skip edge as a right-side elbow and widens the canvas", () => {
    // a→b→c→d in order, plus a skip a→d (rows 0→3) which must elbow on the right.
    const out = layoutFlowchart(
      flow([["a", "A"], ["b", "B"], ["c", "C"], ["d", "D"]], [["a", "b"], ["b", "c"], ["c", "d"], ["a", "d"]]),
    );
    expect(out.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
    const elbow = out.edges.find((e) => e.from === "a" && e.to === "d")!;
    expect(elbow.path.split("L").length).toBeGreaterThan(2); // multi-segment elbow
    expect(out.width).toBeGreaterThan(210 + 16 + 16);
  });

  it("keeps edge labels and drops edges to unknown nodes", () => {
    const spec = flow([["a", "A"], ["b", "B"]], []);
    spec.edges = [{ from: "a", to: "b", label: "yes" }, { from: "a", to: "ghost" }];
    const out = layoutFlowchart(spec);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]!.label).toBe("yes");
  });
});
