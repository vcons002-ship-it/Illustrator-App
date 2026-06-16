import { stripThink } from "../providers/llm/extraction.js";
import type { ChatCapable, ChatTurn } from "../providers/llm/chat.js";
import { normalizeSkill } from "./skills.js";

/**
 * SELF-IMPROVING SKILLS — after the buddy finishes a multi-step task, it can look back at
 * what it did and distill a reusable **playbook** (a Skill) so it does the same kind of task
 * better next time. This is the pure core: decide whether a turn is worth learning from,
 * build the distillation prompt, and tolerantly parse the model's proposal. The host runs
 * the pass (opt-in) and offers the candidate to the reader to keep — nothing is saved silently.
 */

/** A skill the buddy distilled from a just-completed turn, pending the reader's OK. */
export interface SkillProposal {
  name: string;
  description: string;
  body: string;
}

/** Strip a single surrounding code fence (some models wrap JSON). */
function stripFences(s: string): string {
  const t = s.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(t);
  return (m ? m[1]! : t).trim();
}

/**
 * Whether a finished turn is worth distilling: it took at least a couple of SUCCESSFUL tool
 * steps (a real procedure), not a one-liner or a turn that mostly failed.
 */
export function worthLearning(toolResults: readonly { result: { error?: string } }[]): boolean {
  return toolResults.filter((t) => !t.result.error).length >= 2;
}

/** The prompt that asks the model to distill a reusable playbook from the transcript (or decline). */
export function buildSkillProposalPrompt(goal: string, transcript: readonly ChatTurn[]): ChatTurn[] {
  const convo = transcript
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join("\n")
    .slice(0, 6000);
  return [
    {
      role: "system",
      content:
        "You are reviewing a conversation where an assistant just completed a multi-step task. If — and " +
        "ONLY if — the approach is a REUSABLE procedure the reader would plausibly want repeated later " +
        "(not a one-off fact, not trivial, not tied to throwaway specifics), distill it into a durable " +
        "SKILL: a short kebab-case name, a one-line WHEN-to-use description, and a concise markdown body " +
        "of the GENERALIZED steps (no secrets, no one-time values like a specific date or ticker). If it " +
        'is NOT worth saving, reply with exactly {"skip":true}.\n' +
        'Reply with ONLY JSON: {"name":"...","description":"...","body":"..."} or {"skip":true}.',
    },
    { role: "user", content: `GOAL: ${goal}\n\nTRANSCRIPT:\n${convo}` },
  ];
}

/**
 * Tolerant parse: strips a local model's <think> preamble and any code fence, honours
 * {"skip":true}, and normalizes/bounds the fields (reusing the skills store's caps).
 * Returns undefined when the model declined or the proposal is unusable.
 */
export function parseSkillProposal(raw: string): SkillProposal | undefined {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(stripFences(stripThink(raw))) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (obj.skip === true || typeof obj.name !== "string" || typeof obj.body !== "string") return undefined;
  const normalized = normalizeSkill({
    name: obj.name,
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    body: obj.body,
  });
  if (!normalized) return undefined;
  return { name: normalized.name, description: normalized.description, body: normalized.body };
}

/** Run one distillation pass against the LLM; returns a candidate skill or undefined. */
export async function runSkillProposal(
  llm: ChatCapable,
  opts: { goal: string; transcript: readonly ChatTurn[]; signal?: AbortSignal },
): Promise<SkillProposal | undefined> {
  const reply = await llm.chat(buildSkillProposalPrompt(opts.goal, opts.transcript), {
    maxTokens: 1024,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return parseSkillProposal(reply);
}
