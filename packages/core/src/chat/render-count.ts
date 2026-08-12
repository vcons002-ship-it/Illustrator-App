/**
 * HOW MANY PICTURES DID THE READER ACTUALLY ASK FOR?
 *
 * "Generate 3 images of yourself" kept coming back as one picture with no checklist behind it.
 * Three separate attempts to fix it in the system prompt failed — the rule saying several images
 * means a checklist was present, correct and read every time, and lost to whichever neighbouring
 * rule the model reached first. At that point the prompt is not the lever.
 *
 * So the app counts. A number sitting directly in front of a picture word is not a matter of
 * interpretation, and a note carrying that count rides the turn that asks for it — specific, and
 * arriving WITH the request rather than sitting in a standing instruction competing with forty
 * others.
 *
 * DELIBERATELY NARROW. The number has to be immediately in front of the picture word, so "draw a
 * picture of 3 cats" is one picture of three cats and does not match — the noun after the number is
 * "cats". Renders cost the reader real GPU time, so a wrong count here is expensive in a way a
 * missed one is not, and everything about this leans toward not firing.
 */

/** Words for a rendered image. Kept to the ones people actually type when they want art made. */
const PICTURE = "(?:images?|pictures?|pics?|portraits?|illustrations?|drawings?|renders?|photos?|artworks?)";

/** Number words worth honouring. Above ten, a reader types the digits. */
const WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/**
 * The most renders one message may set running.
 *
 * Not a technical limit — a bound on what an accident can cost. A misread "100 images" is an hour
 * of GPU and a queue the reader has to sit through, so anything past this is treated as no count at
 * all and left to the model, which will ask.
 */
export const MAX_REQUESTED_RENDERS = 8;

/**
 * The number of separate pictures this message asks for, or undefined for "not stated".
 *
 * undefined is the answer for one picture as well as for no picture: a single render needs no
 * checklist and no note, so the two cases want the same behaviour and collapsing them keeps every
 * caller from having to remember which is which. PURE.
 */
export function requestedRenderCount(text: string): number | undefined {
  const re = new RegExp(`\\b(\\d{1,3}|${Object.keys(WORDS).join("|")})\\s+(?:\\w+\\s+)?${PICTURE}\\b`, "i");
  const m = re.exec(text);
  if (!m) return undefined;
  const raw = m[1]!.toLowerCase();
  const n = WORDS[raw] ?? Number(raw);
  if (!Number.isFinite(n) || n < 2 || n > MAX_REQUESTED_RENDERS) return undefined;
  return n;
}

/**
 * The note that rides the turn, or "" when there is nothing to say.
 *
 * Silent once a checklist is already running: the plan itself is then the instruction, and a second
 * voice telling the model to plan something it has already planned is how a model ends up calling
 * set_plan again mid-run and starting over.
 */
export function requestedRendersNote(text: string, hasPlan: boolean): string {
  if (hasPlan) return "";
  const n = requestedRenderCount(text);
  if (n === undefined) return "";
  return (
    `THE READER ASKED FOR ${n} SEPARATE PICTURES. That is ${n} distinct actions, so it needs a ` +
    `checklist: call set_plan with ${n} steps, one picture each, and then do the FIRST step. Do not ` +
    "render anything before the plan exists — a render ends this turn, and whatever you meant to do " +
    "after it never happens."
  );
}

/**
 * WHICH STEP IS THIS PICTURE, when the model's own bookkeeping is behind.
 *
 * The label on a render read "Step 1 of 3" for the second picture as well as the first. It was not
 * lying: the number came from the first UNFINISHED step, and the model had narrated its progress —
 * "Image 1 is done. Now generating the second image" — instead of calling complete_step. So step 1
 * genuinely was still open when the second render landed, and the label said so.
 *
 * The app does not have to take the model's word for it. It knows how many pictures it has produced
 * for this checklist, and the reader can count them on the screen.
 *
 * The HIGHER of the two wins, which is what makes one rule serve both shapes. On a mixed checklist
 * ("write, draw, write, draw") the first render belongs to step 2, and the tick count knows that
 * while the render count does not; on a run of three pictures with no ticks at all the render count
 * knows and the ticks do not. Taking the larger is right in both, and can only move a label FORWARD
 * — it never relabels a picture as earlier than the checklist itself believes. PURE.
 */
export function renderStepNumber(statuses: readonly string[], rendersSoFar: number): number {
  const total = statuses.length;
  if (total === 0) return 0;
  const firstOpen = statuses.findIndex((s) => s !== "done");
  const byTicks = firstOpen >= 0 ? firstOpen + 1 : total;
  return Math.min(total, Math.max(byTicks, rendersSoFar));
}

/**
 * A checklist's identity, ignoring how far through it is.
 *
 * Lets the render tally notice it has moved to a DIFFERENT checklist and reset itself, rather than
 * needing a reset at each of the eleven places a plan is installed — every one of which would be a
 * chance to miss one. Status is deliberately excluded: it changes on every tick, and a key that
 * moved with it would reset the tally constantly. PURE.
 */
export function planIdentity(plan: { goal?: string; steps: readonly { text: string }[] }): string {
  return [plan.goal ?? "", ...plan.steps.map((s) => s.text)].join(" ");
}
