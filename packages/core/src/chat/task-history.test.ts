import { describe, expect, it } from "vitest";
import { RECURRENCE_MIN_SHARED, sharedTopicCount, taskRecurred, topicTokens } from "./task-history.js";

describe("topicTokens / sharedTopicCount", () => {
  it("keeps significant words and counts overlap, ignoring stop words + short tokens", () => {
    expect([...topicTokens("compare two photonics stocks for me")].sort()).toEqual(["compare", "photonics", "stocks"]);
    expect(sharedTopicCount("compare photonics stocks by P/E", "compare these photonics stocks")).toBe(3);
    expect(sharedTopicCount("summarise my unread email", "draw a picture of a cat")).toBe(0);
  });
});

describe("taskRecurred", () => {
  const history = [{ goal: "compare two photonics stocks", at: 1 }, { goal: "plan my taxes", at: 2 }];
  it("fires only when a prior task shares ≥ the threshold significant words", () => {
    expect(taskRecurred(history, "compare three photonics stocks on growth")).toBe(true); // shares compare+photonics+stocks
    expect(taskRecurred(history, "illustrate a fantasy novel")).toBe(false);
    expect(RECURRENCE_MIN_SHARED).toBe(2);
  });
});
