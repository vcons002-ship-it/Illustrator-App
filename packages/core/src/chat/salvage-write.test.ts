import { describe, expect, it } from "vitest";
import { resumeWriteNote, salvageTruncatedWrite } from "./buddy-tools.js";

/**
 * A LONG FILE'S CALL IS THE ONE THING GUARANTEED TO OUTGROW A GENERATION.
 *
 * `write_file` carries the whole file in one JSON string argument. When the reply stops mid-string
 * the JSON never closes, `parseBuddyToolCalls` yields nothing, and every character the model wrote
 * was discarded — after which the app asked it to write the file again in chunks, out of the same
 * budget, from a context that no longer held the attempt. Reported as "it never actually writes any
 * output": a model producing a complete page every round, producing no file at all.
 *
 * The prefix is not wrong, only short. It is the exact opening of the file, and `append:true` exists
 * to add to it.
 */
const CUT = '{"tool":"write_file","path":"index.html","content":"<!DOCTYPE html>\\n<html>\\n<body>\\n  <h1>Tide times<';

describe("salvageTruncatedWrite", () => {
  it("keeps what arrived, decoded, when the call stops mid-argument", () => {
    const s = salvageTruncatedWrite(CUT)!;
    expect(s.path).toBe("index.html");
    expect(s.content).toBe("<!DOCTYPE html>\n<html>\n<body>\n  <h1>Tide times<");
    expect(s.append).toBe(false);
  });

  it("carries append through, so a continuation that is itself cut off still appends", () => {
    const s = salvageTruncatedWrite('{"tool":"write_file","path":"a.html","append":true,"content":"<p>more');
    expect(s?.append).toBe(true);
    expect(s?.content).toBe("<p>more");
  });

  it("leaves a COMPLETE call alone — that one parses, and re-writing it would duplicate the file", () => {
    expect(salvageTruncatedWrite('{"tool":"write_file","path":"a.txt","content":"hi"}')).toBeUndefined();
  });

  it("takes the LAST attempt when prose or an earlier call precedes it", () => {
    const s = salvageTruncatedWrite(`Right, writing it now.\n${CUT}`);
    expect(s?.path).toBe("index.html");
  });

  it("sees through a fence and a thinking block", () => {
    expect(salvageTruncatedWrite("<think>planning</think>\n```json\n" + CUT)?.path).toBe("index.html");
  });

  /**
   * Guessing what a dangling `\` was about to become is how a salvage corrupts a file. The next
   * chunk supplies it; dropping it costs one character and cannot be wrong.
   */
  it("drops an escape that was itself cut in half rather than guessing it", () => {
    expect(salvageTruncatedWrite('{"tool":"write_file","path":"a.js","content":"line\\')?.content).toBe("line");
    expect(salvageTruncatedWrite('{"tool":"write_file","path":"a.js","content":"a\\u26')?.content).toBe("a");
  });

  it("decodes the escapes a file body actually contains", () => {
    const s = salvageTruncatedWrite('{"tool":"write_file","path":"a.js","content":"say(\\"hi\\")\\n\\tif (a\\\\b) {');
    expect(s?.content).toBe('say("hi")\n\tif (a\\b) {');
  });

  it("gives up rather than write to nowhere, or write nothing", () => {
    expect(salvageTruncatedWrite('{"tool":"write_file","pa'), "no path — nothing to write TO").toBeUndefined();
    expect(salvageTruncatedWrite('{"tool":"write_file","path":"a.txt","content":"'), "no bytes").toBeUndefined();
    expect(salvageTruncatedWrite('{"tool":"run_command","command":"npm test'), "not a file write").toBeUndefined();
    expect(salvageTruncatedWrite("just some prose")).toBeUndefined();
  });
});

describe("resumeWriteNote", () => {
  it("says the file is real, and where it stops", () => {
    const note = resumeWriteNote("index.html", 47, "<h1>Tide times<");
    expect(note).toContain("index.html exists");
    expect(note).toContain("47 characters");
    expect(note).toContain('"append":true');
    expect(note).toContain("<h1>Tide times<");
    // The failure this replaces is the model rewriting the file from the top.
    expect(note).toContain("nothing needs rewriting");
  });

  it("quotes the TAIL, because that is where the model has to carry on from", () => {
    const note = resumeWriteNote("a.txt", 5000, "START" + "x".repeat(5000) + "END");
    expect(note).toContain("END");
    expect(note).not.toContain("START");
  });
});
