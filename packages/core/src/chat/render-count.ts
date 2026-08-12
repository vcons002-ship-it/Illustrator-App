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
