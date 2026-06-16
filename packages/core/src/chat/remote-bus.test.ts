import { describe, expect, it } from "vitest";
import type { TaskItem } from "../providers/google.js";
import { busCommands, commandText, formatBusReply, isBusCommand, MAX_BUS_REPLY_CHARS, REMOTE_BUS_PREFIX } from "./remote-bus.js";

const task = (t: Partial<TaskItem>): TaskItem => ({ title: "x", ...t });

describe("isBusCommand / commandText", () => {
  it("matches VR-prefixed, non-completed tasks with an id (case-insensitive)", () => {
    expect(isBusCommand(task({ id: "1", title: "VR: summarise my mail" }))).toBe(true);
    expect(isBusCommand(task({ id: "2", title: "  vr: do x" }))).toBe(true);
    expect(isBusCommand(task({ id: "3", title: "buy milk" }))).toBe(false);
    expect(isBusCommand(task({ id: "4", title: "VR: done", status: "completed" }))).toBe(false);
    expect(isBusCommand(task({ title: "VR: no id" }))).toBe(false);
  });
  it("strips the prefix to the instruction", () => {
    expect(commandText(task({ title: `${REMOTE_BUS_PREFIX} summarise my mail` }))).toBe("summarise my mail");
    expect(commandText(task({ title: "vr:   trimmed  " }))).toBe("trimmed");
  });
});

describe("busCommands", () => {
  it("returns only non-empty VR commands as {id,text}", () => {
    const cmds = busCommands([
      task({ id: "1", title: "VR: a" }),
      task({ id: "2", title: "not a command" }),
      task({ id: "3", title: "VR:   " }), // empty instruction
      task({ id: "4", title: "VR: b", status: "completed" }),
    ]);
    expect(cmds).toEqual([{ id: "1", text: "a" }]);
  });
});

describe("formatBusReply", () => {
  it("marks + caps the answer and handles empty", () => {
    expect(formatBusReply("the answer")).toBe("🤖 the answer");
    expect(formatBusReply("   ")).toContain("done — see");
    expect(formatBusReply("x".repeat(MAX_BUS_REPLY_CHARS + 500)).length).toBeLessThanOrEqual(MAX_BUS_REPLY_CHARS + 3);
  });
});
