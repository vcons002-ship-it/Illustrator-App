# The agent harness — what the app manages, what the model manages

This document exists because a task the model can do instantly — recite the alphabet backwards,
skipping Q — became unreliable when this app split it across messages. That is a harness problem, not
a model problem, and three rounds of prompt fixes did not touch it.

It is in two halves. The first is what the published harnesses actually do, read from primary
documentation. The second is the methodology that follows, and how it lands on the code we have.

Claims are marked:

- **[D]** — documented, and the page was fetched and read.
- **[D?]** — quoted from a primary source that was *not* re-read during verification. Directionally
  right, but do not build on it without opening the page.
- **[CODE]** — read from this repo, with `file:line`.
- **[I]** — inference, labelled as such.

---

## Part 1 — What the reference harnesses do

### 1.1 There is no "tool role", and that was the wrong thing to reach for

The obvious diagnosis for our failures was "we have no tool role, so the model reads our bookkeeping
as the reader speaking." Half of that is right. The first half is not.

**Anthropic's API has no tool role either.** [D]
<https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls>

> "Unlike APIs that separate tool use or use special roles like `tool` or `function`, the Claude API
> integrates tools directly into the `user` and `assistant` message structure. Messages contain
> arrays of `text`, `image`, `tool_use`, and `tool_result` blocks. `user` messages include client
> content and `tool_result`, while `assistant` messages contain AI-generated content and
> `tool_use`."

```json
{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01A09q…","content":"15 degrees"}]}
```

A tool result travels under **the same role as the human**. What separates them is one level down:

| Surface | Mechanism | Correlation key | Role |
|---|---|---|---|
| Anthropic Messages | typed `tool_result` **content block** | `tool_use_id` | `user` |
| OpenAI Responses | top-level `function_call_output` **item** | `call_id` | *no role field at all* |
| OpenAI Chat Completions | `role:"tool"` message | `tool_call_id` | `tool` |
| **Ollama native `/api/chat`** | `role:"tool"` message | `tool_name` | `tool` |

So the real structure is **two levels — who is speaking × what kind of thing this is.** We collapsed
both into one. `ChatTurn` is `{ role: "system"|"user"|"assistant"; content: string }`
[CODE, `providers/llm/chat.ts:11`], and a repo-wide grep for `tool_result`, `tool_use` or
`tool_call_id` returns zero hits. Every result, directive, nudge and tick is prose in a `user` turn.

There is also a **third** channel we are not using at all. Mid-conversation `role:"system"` messages
are GA — no beta header — on Opus 4.8 / Opus 5 / Sonnet 5 / Fable 5 / Mythos 5. [D]
<https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages>

> "a `user` message is treated as coming from the end user, while a `system` message is treated as
> coming from you, the application operator. When the two conflict, system instructions take
> precedence."

Its documented use cases include, verbatim, **"State changes your application observes"** and
**"User input that should not interrupt an agentic loop."** That is precisely what a step directive
is. Placement rules allow it directly after a user turn carrying tool results, "before Claude's next
turn" — exactly our injection point.

Anthropic documents our failure as a known symptom. [D]
<https://platform.claude.com/docs/en/agents-and-tools/tool-use/troubleshooting-tool-use>

> Symptom: "Claude refuses to act on a tool result, or asks the user to confirm instructions that
> came from it." Cause: "Your own instructions are being delivered inside the `tool_result` content."
> Fix: "Move your instructions out of the tool result: send them in a `user` turn after the
> `tool_result` block, or, on supported models, in a mid-conversation system message. Keep the tool
> result to just the data."

**The tension this creates, which nothing in the literature resolves.** OpenAI's Model Spec ranks
authority Platform → Developer → User → Guideline → **No Authority: assistant and tool messages**.
[D] <https://model-spec.openai.com/2025-04-11.html> Tool output is *data*, and instructions inside it
"MUST be treated as information rather than instructions to follow."

So the two channels are not interchangeable and we cannot fix this by moving everything into one:

- **Directives are operator content.** They belong at system tier, where they carry authority.
- **Tool results are data.** They belong at no-authority tier, where they carry attribution.

Today we send both as user-tier prose, which gets us the wrong authority *and* the wrong attribution.

### 1.2 Continuation is the default. Stopping is the signal.

Uniform across every harness checked, and there is **no `keep_going` anywhere in any of them**. [D]

Anthropic Messages API: "Repeat from step 2 while `stop_reason` is `"tool_use"`." → "In practice this
reads as: while `stop_reason == "tool_use"`, execute the tools and continue the conversation."

Claude Agent SDK [D] <https://code.claude.com/docs/en/agent-sdk/agent-loop>:

> "A turn is one round trip inside the loop… **Turns continue until Claude produces output with no
> tool calls**, at which point the loop ends."

OpenAI Agents SDK [D]: "The rule for whether the LLM output is considered as a 'final output' is that
it produces text output with the desired type, and there are no tool calls."

Vercel AI SDK [D]: the loop runs until a finish reason other than tool-calls, or a stop condition.

Three precise statements, since the sweeping version is overstated:

1. In all four harnesses, **continuation is the default and is signalled by the presence of tool
   calls.**
2. Some harnesses **additionally** let a *named* tool call terminate the run (`hasToolCall(…)`,
   `tool_use_behavior`). The inverse affordance exists; ours does not.
3. **No harness requires the model to call a tool in order to be permitted to continue.**

Where continuation must be *forced*, it is a **host** act with a stated reason, never a model act.
[D] <https://code.claude.com/docs/en/hooks.md> — the Stop hook: `decision: "block"` "prevents Claude
from stopping"; `reason` is "Required when `decision` is `"block"`. Tells Claude why it should
continue." The model is told it is inside a forced loop via `stop_hook_active`, and the consecutive
cap is a default, raisable with `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`.

And the shipped "work until done" feature is built this way, not with a model-side primitive. [D]
<https://code.claude.com/docs/en/goal.md>: `/goal` "sets a completion condition and Claude keeps
working toward it… After each turn, a small fast model checks whether the condition holds. If not,
Claude starts another turn instead of returning control to you." It is "a wrapper around a
session-scoped prompt-based Stop hook."

**Our round cap is not the problem.** Anthropic documents *no* default cap ("No limit" for both
`max_turns` and `max_budget`); OpenAI's SDK default is 10; Vercel's is 20. Our
`MAX_BUDDY_TOOL_ROUNDS = 50` is unremarkable, and neither reported failure is caused by it.

### 1.3 The model authors *and* grades. The harness stores, and vetoes.

This is the finding that most directly contradicts what we built. [D]
<https://code.claude.com/docs/en/agent-sdk/todo-tracking>

> "1. **Created**: Claude adds the todo as `pending` when it identifies a task. 2. **Activated**:
> Claude sets the todo to `in_progress` when it starts the work. 3. **Completed**: Claude marks it
> completed when the task finishes successfully."

**Nothing in the reference harness grades a step from observed evidence.** No confidence score, no
verdict field, no evidence field, across `todo-tracking`, `interactive-mode` and `hooks.md`.

The harness is not a passive echo, though. It does three things, and the *shape* of them matters:

1. **Mints IDs** — the ID is not in the model's input, it comes back in the `tool_result`.
2. **Repairs close-but-wrong key names** (`task_id` → `taskId`).
3. **Hard-vetoes via hooks** — `TaskCompleted` exit-2 "Prevents the task from being marked as
   completed."

The veto shape is the lesson: **the model claims completion, and the harness refuses with a reason.**
It never silently overwrites the model's belief behind its back. That keeps one coherent narrative —
model asserts, harness refuses, model retries — instead of a transcript where the app and the model's
own prior output flatly contradict each other in the same voice.

Two more transferable details:

- **Per-item patches, not whole-list rewrites.** `TodoWrite` is retired; sessions now use
  `TaskCreate` (one item) + `TaskUpdate(taskId, …)`. A whole-array rewrite forces the model to
  re-assert every item's status on every touch, which is where drift enters. [D]
- **Display string and state string are separate fields** — `subject` ("Run tests") vs `activeForm`
  ("Running tests"), so rendering never mutates state. [D]

### 1.4 Harness speech is tagged, factual, and out of the chat

Claude Code wraps hook-injected text in a **system reminder** that "doesn't appear as a chat message
in the interface", and each injection "starts with the hook's name". [D, `hooks.md`]

The register guidance is the single most transferable sentence in the corpus. [D, `hooks.md`]

> "Write the text as **factual statements rather than imperative system instructions**. Phrasing such
> as 'The deployment target is production' or 'This repo uses `bun test`' reads as project
> information. **Text framed as out-of-band system commands can trigger Claude's prompt-injection
> defenses, which causes Claude to surface the text to you instead of treating it as context.**"

Our step directive is `[✓ Previous step done. Now do ONLY step 4 of 25: … Call its tool and stop —
don't recap or explain.]` — imperative, bracketed, under the reader's role, contradicting the model's
own last output. That is close to a worked example of what not to do.

Model-facing and user-facing text are also **separate typed fields**: `additionalContext` goes to the
model; `systemMessage` is "shown to the user"; `stopReason` is shown to the user and explicitly "Not
shown to Claude." [D]

### 1.5 On decomposition, the documentation is silent — and that matters

**No document from either lab says "don't split a one-response task across model calls."** The
material that bears on decomposition — *Building effective agents*, the context-engineering posts,
OpenAI's practical guide — could not be re-verified this pass and is marked [D?] throughout. It reads
as authentic, but it is not confirmed, and it all scopes to splitting across *separate agents or
separate context windows*, not intra-conversation turns.

What **is** verified points the same way from a different angle:

- **A tool-use loop is one turn**, not N turns. The trained-for shape for a 25-item sequence is *one
  turn containing 25 tool calls*. [D]
- **Multiple tool calls per response are expected.** Anthropic's `disable_parallel_tool_use: true`
  yields "at most one tool call per response" — exactly the shape for strictly sequential work. [D]
- **There is no blessed "emit N assistant messages" concept.** OpenAI's own runner reads
  `message_items[-1]` for the final output — only the last message item counts, even though all are
  preserved. **If you want N discrete bubbles from one response, tool calls are the supported
  vehicle; multiple message items are not.** [D]
- **Cross-step state lives in a queryable store returning structured results, or is re-injected every
  request** (CLAUDE.md). It is never left to be inferred from accumulated transcript prose. [D]

So: applying "don't decompose" here is **inference by structural analogy [I]**, and is labelled as
such below. The structural facts it rests on are documented.

---

## Part 2 — Our harness, as the code actually is

### 2.1 The sharpest finding: the model already has the position

This inverts the diagnosis I gave before the research.

`seriesProgressNote` [CODE, `buddy-tools.ts:2547`] hands back, on **every** accepted `keep_going`:

> `[go on — you have sent 8 messages so far this turn, in order: "Z", "Y", "X", "W", "V", "U", "T",
> "S". Send the NEXT one; do not repeat any of these.]`

It degrades to a bare count only when an item exceeds 24 chars or the join exceeds 400. Twenty-six
single letters join to ~130 characters. **The echo survives the entire alphabet. The full ordered
position is handed back every single round.**

And the model still loses its place.

That localises the failure precisely. It is **not** an information problem — the position is in
context, recent, and explicit. It is an **attribution and authority** problem: the position arrives
wearing the reader's face, in the same role as the human, contradicting the model's own assistant
turns two lines above. The reasoning capture from the failing run says exactly this:

> "The fact that the previous turn (Step 4) has a model output of 'V' in the prompt history is
> confusing, but I must follow the current user prompt which explicitly asks for 'V'."

The model resolved a conflict between its own memory and an apparent human instruction by trusting
the human. That is correct behaviour. We built the conflict.

### 2.2 `keep_going` cannot be called by a model using native tool calling

[CODE, verified] `ollamaToolSchemas` (`buddy-tools.ts:3280–3484`) defines **23** functions.
`keep_going` is not one of them. `complete_step` is.

The worker enables native function calling for any Ollama model advertising the capability. Such a
model is handed 23 schemas, none of which is `keep_going`. To continue a series it must abandon
structured tool calling and emit the raw text-JSON protocol instead — which the prompt elsewhere
frames as the fallback.

This is the direct, mechanical answer to a symptom reported from real use: *"keep_going works, but
the AI isn't calling it properly despite knowing it needs to in the reasoning and thinking it will."*
It knew. It intended to. It could not.

Three more facts about `keep_going` [CODE]:

- It has **no entry in the TOOLS catalog** — no `- {"tool":"keep_going"} — …` bullet exists.
- Its entire model-facing definition is **two prose sentences** inside `multiStepGuide`
  (`buddy-tools.ts:1591–1604`).
- Those sentences are in the **no-plan branch only**. Once a checklist is active, `keep_going`
  vanishes from the prompt completely — so a model mid-plan that needs several messages for one step
  has no documented way to do it.

`runBuddyTool`'s own case for it is unreachable and returns `{ error: "keep_going only means anything
inside a turn" }` [CODE, `buddy-session.ts:1457`].

### 2.3 The checklist regression: one channel, three meanings

Confirmed deterministic, not a race. [CODE, every link verified]

1. `engine.worker.ts:6058–6061` — the in-turn tick advances its workflow and posts the advanced
   projection as a plain `buddyPlan` message.
2. `worker-protocol.ts:517` — `{ type: "buddyPlan"; requestId; plan }`. **No discriminator.** Three
   producers post this identical shape: `set_plan` (4988), `complete_step` (4995), the tick (6061).
3. `useEngineWorker.ts:1302` — flattens all three into one host event `{kind:"plan"}`. Provenance
   erased.
4. `App.tsx:7184–7199` — in app-managed mode **every** plan event is read as a model re-plan:
   `applyWorkflow(recompileWorkflow(buddyWorkflowRef.current /* pre-turn copy */, e.plan, …))`,
   evidence wiped, `planCompiledThisTurn = true`.
5. `workflow.ts:448–462` — `recompileWorkflow` takes statuses **only from `prev`**.
6. `workflow.ts:367–433` — `compileWorkflow` hardcodes `status: "pending"`.

**There is no path by which a done-marked projection can re-enter the host's workflow.** Hence the
card reading 0/25 while the chat shows 25 sent messages: the prose path and the state path are
disjoint. And `planCompiledThisTurn` staying true sends the end-of-turn executor down the *planning*
branch, which issues `stepDirective(…, "start")` — *"Checklist ready — 25 steps. Now do ONLY step 1
of 25"*. That is the loop back to the beginning.

The source comment at `engine.worker.ts:6041` claiming the advance rides "the SAME `buddyPlan` post
that set_plan and complete_step already use, so the card and the stored workflow move exactly as
before" is wrong, and `buddy-session.ts:552` already states the rule it breaks: *"Passing the
structure in would put two copies of the run's state in play, and the one in here would be the stale
one."*

### 2.4 Three more defects the read turned up

**Cross-step evidence bleed.** [CODE] `toolResults` is declared once per **turn**
(`buddy-session.ts:604`), pushed to at ten sites, and **never cleared** — yet line 834 hands the
whole accumulated array to every tick. Step 2's `image` contract is satisfiable by step 1's render. A
three-image checklist can tick three steps off one picture. The host's equivalent
(`buddyStepEvidenceRef`) *is* reset per advance, so **the same step is judged by two different rules
depending on which side judges it**.

**A text step's contract cannot see content.** [CODE, `workflow.ts:627`] An inferred text step is
judged by `evidence.text.trim().length >= 1`, and inferred contracts never set `dw.regex`. **"V",
"W", and "I already sent V, moving on" advance the workflow identically.** The grader cannot catch a
position error, which is the only error this task class has.

**The prompt contradicts itself about turn boundaries.** [CODE] 21 tools suspend the turn
(`buddy-session.ts:430`). The string `"ENDS the turn"` appears **once** in the 70-line always-on
prompt. Meanwhile `routingGuide` — always present — says:

> "Every tool's result comes back to you, so CHAIN tools: search → read → write → run, reacting to
> each result."

`write_file` and `run_command` are both host tools. So are `read_data`, `find_files`, `screenshot`,
`control_ui`, `tv_chart`, `browser_eval`, `delegate`, `prep_order`, `send_email`, `set_cell` and
`add_formula_column` — none of which the prompt names, and `read_data` in particular is a read the
prompt explicitly promises "comes straight back to you inside THIS turn."

---

## Part 3 — Four laws

Everything below follows from Part 1, and each law names the specific thing we do that violates it.

> **L1 — Continuation is the default. The absence of tool calls is the stop signal.**
> Never require an affirmative act to be *allowed* to continue. Where continuation must be forced, the
> host forces it and says why.
> *We invert this at `buddy-session.ts:744`.*

> **L2 — Every piece of run state has exactly one owner.**
> "Client-managed and server-managed approaches cannot be mixed in a single run" [D]. LangGraph keeps
> one checkpoint per thread. Our own contract at `buddy-session.ts:552` already says it.
> *We violate this with two live workflows and one undiscriminated channel.*

> **L3 — The model authors and grades. The harness stores, mints identity, and vetoes with a reason.**
> Never silently overwrite the model's belief about its own progress.
> *App-managed mode inverts this: we grade, and the model has no say.*

> **L4 — Harness speech is attributable and factual. Never the reader's voice; never a command.**
> "Factual statements rather than imperative system instructions." Tagged so its origin is
> unambiguous.
> *All seven of our injection sites are bracketed imperatives under `role:"user"`.*

And one derived rule, marked as inference:

> **L5 [I] — Do not split across model calls what the model can do in one.**
> No document states this. It follows from three that are documented: a tool-use loop is *one* turn;
> N discrete outputs are carried by tool calls, not by N turns; and cross-step state belongs in a
> queryable store, not in accumulated prose. A backwards alphabet is maximally *dependent* work — it
> gets none of decomposition's benefit and pays all of its coordination cost.

---

## Part 4 — The methodology

### M1 — Make the work the tool call. Delete `keep_going`.

The central move, and it collapses four problems at once.

`keep_going` is a tool that **does nothing**. It exists only to buy permission, which forces the model
into a two-part act every round: write prose *and* remember to attach a no-op call. Miss the second
half and the task silently ends.

Replace it with `send_message(text)` — a real in-worker tool that emits one chat bubble and returns a
real result. Then:

| Problem today | Why it goes away |
|---|---|
| Continuation needs an affirmative act (L1) | A `send_message` call *is* a tool call, so the loop continues by default. The turn ends when the model stops calling it. |
| Native-tool-calling models can't emit `keep_going` | `send_message` goes in `ollamaToolSchemas` like any other tool. |
| Position arrives as reader speech (L4) | Position rides in the **tool result** — the trained-for place for it. |
| A text step's contract can't see content (§2.4) | The argument *is* the content. `evaluateStep` can check that step 7 sent `"T"`, not merely that some prose existed. |

The prose/permission split disappears: the model's output for item N is one tool call, not a message
plus a token. This is the reference shape — "if you want N discrete bubbles from one response, tool
calls are the supported vehicle" [D].

**And for a pure recitation, prefer not splitting at all (L5).** The model emits the whole sequence in
one response with a separator and the renderer paces it into bubbles. Zero rounds, zero state, zero
position tracking — the alphabet becomes exactly as easy as the model finds it, forwards or backwards,
skipping Q or not. Reserve `send_message` for sequences genuinely interleaved with real work.

Note what this is *not*: it does not ask the app to guess how many messages the request implies. That
was the over-fit we already reverted, where "count from 15 to 25" was read as 25 messages instead of
11. Here the model writes the items; nothing counts anything.

### M2 — One owner for the workflow

Two changes, both small.

**Discriminate the channel.** `buddyPlan` currently carries three different meanings from three
producers. Give it an origin: `{ type: "buddyPlan"; origin: "set_plan" | "advance"; … }`. The host
recompiles only on `set_plan`, and **adopts** on `advance`. `recompileWorkflow` is correct for a model
re-planning; it is simply the wrong function for an app advancing.

**Decide who owns it during a turn.** The worker's tick is the right idea and should keep the turn —
handing control back per step was the original bug. So the worker owns the workflow for the turn's
duration and the host adopts at the end, rather than both computing. That is L2, and
`buddy-session.ts:552` already specifies it.

While in there: `toolResults` must be **sliced per step**, not handed whole to every tick, or the
evidence bleed in §2.4 stays.

### M3 — A typed envelope for harness speech

Not "add a tool role" — that was the wrong frame. Add the **second level** we collapsed.

Extend the internal turn with a discriminator alongside the role:

```ts
type ChatTurn = {
  role: "system" | "user" | "assistant";
  kind?: "tool_result" | "operator";   // absent = ordinary speech
  toolUseId?: string;
  isError?: boolean;
  content: string;
};
```

Then project per provider, best-effort, degrading where a capability is absent:

| Provider | `kind: "tool_result"` | `kind: "operator"` |
|---|---|---|
| Claude | `role:"user"` + `tool_result` content block | mid-conversation `role:"system"` where supported |
| OpenAI Responses | `function_call_output` item | `role:"developer"` |
| **Ollama native** | `role:"tool"` (documented, available today) | `role:"system"` if accepted; else tagged user prose |
| Anything else | tagged user prose, as now | tagged user prose, as now |

The two tiers must stay separate, per §1.1: directives are **operator** content and need authority;
tool results are **data** and need attribution. Collapsing them in either direction loses something.

The one thing worth doing even with no plumbing at all: make the fallback envelope **stable and
self-identifying** rather than a bare bracket, so it never reads as the reader typing.

`is_error` follows for free, and matters — models are documented to self-correct on typed errors in a
way they do not on prose complaints.

### M4 — Grade by veto, not by evidence

L3 says the model authors and grades. Under M1 this mostly resolves itself: a `send_message("T")`
call is unambiguous evidence of exactly what was sent, so "grading" becomes checking an argument
rather than inferring intent from prose.

Where a genuine contract remains (a render happened, a file exists), keep the check but change its
**shape**: the model claims, the app refuses with a reason, the model retries. Never overwrite the
model's belief silently. `evaluateStep` becomes a validator of a claim rather than an oracle that
replaces one.

### M5 — Directives as facts

Free, immediate, and independently worth doing whatever else happens. Today:

> `[✓ Previous step done. Now do ONLY step 4 of 25: send the letter W. Call its tool and stop — don't
> recap or explain.]`

Under the documented register guidance:

> `Checklist state: step 4 of 25 is current — "send the letter W". Sent so far: Z, Y, X.`

Same information, stated rather than commanded, and no longer shaped like an out-of-band system
command — which is documented to trigger prompt-injection defences and get the text surfaced to the
reader instead of acted on.

Also drop `Date.now()` stamping on directives (`App.tsx:7167`), which is what produced *"The user's
prompt in this specific turn [timestamp] is the system telling me to do step 1."*

### M6 — Two audiences, two channels

Progress chrome the reader needs and the model does not should not enter the model's context. The
reference splits these into separate typed fields (`additionalContext` vs `systemMessage` vs
`stopReason`, the last explicitly "Not shown to Claude"). Ours share one prose stream, permanently.

### What this removes

Worth stating plainly, because the current design's weight is itself a cost:

- `keep_going` (tool, prompt prose, interception at `buddy-session.ts:1094`, refusal branch)
- `seriesProgressNote` and its two echo caps — position moves into tool results
- the stall check, `isStallConfirmation`, `stalledProse`, `askedIfDone` — the app asks "was that the
  last one?" only because it cannot tell stalled from finished; with tool calls, it can
- the wrap-up directive's `keep_going` carve-out
- the reasoning replay at `buddy-tools.ts:2576`, which narrates the model's own thoughts back to it in
  the reader's voice

Five mechanisms, all built to compensate for one inverted polarity.

---

## Part 5 — Sequencing

1. **The checklist regression (M2, discriminator only).** A live bug with a two-line fix. Do it first
   and independently — it restores ticking regardless of what follows.
2. **`send_message` replaces `keep_going` (M1).** The load-bearing change. Includes the schema entry,
   the catalog entry, and deleting the five compensating mechanisms above.
3. **Register (M5).** Free, no plumbing, no token cost.
4. **Evidence slicing + veto shape (M2 tail, M4).**
5. **The typed envelope (M3).** Largest, most valuable, wants its own pass — and needs the empirical
   check in §6 first.
6. **Audience split (M6).**

Steps 1–4 need no provider work and no new prompt tokens, which matters: the always-on prompt measures
**5,796 of its 5,800-token budget** — four tokens of headroom [CODE, reproduced]. M1 and M5 *return*
tokens.

---

## Part 6 — What is genuinely constrained, and what we assumed wrongly

### Real

- **21 host tools suspend the turn.** Main-thread UI and user approval are irreducible. But the
  surface is larger than it needs to be, and four of the 21 (`read_data`, `find_files`, `tv_chart`,
  `prep_order`) are reads the prompt already promises will return in-turn.
- **The 5,800-token always-on ceiling** — real pressure, but self-imposed, measured as `chars/4`
  rather than by a tokenizer, enforced by one vitest assertion, and only for `loadedToolsets: []`.
- **`ollamaThink` is binary.** No "low". `think: false` makes a thinking model reason in plain content,
  so `stripThink` finds nothing and the monologue reaches the reader. (Task #18.)
- **Ollama's OpenAI-compat `/v1` path does not support `tool_choice`** [D] — anything wanting to
  *force* a call on that path is blocked.
- **Mid-conversation `role:"system"` is documented only for recent models** — any operator-channel
  design needs a fallback.
- **Authority vs attribution is unsolved in the literature.** Demoting directives to a tool channel
  gains correct attribution but strips authority. Keep the two tiers separate; do not merge them.

### Assumed, but false

- ~~"We have no tool role available."~~ **False for Ollama.** Native `/api/chat` documents
  `role:"tool"` with a worked example. The blocker is our own `ChatTurn` type and `splitSystem`.
- ~~"`role:"user"` for bookkeeping is inherently the bug."~~ **False.** Anthropic does the same. The
  bug is the untyped prose payload.
- ~~"The series echo is too small to carry the alphabet."~~ **False** — it carries all 26. The model
  has the position and loses it anyway, which is what localises this to attribution, not information.
- ~~"50 rounds is out of line."~~ **False.** Anthropic documents no cap at all.
- ~~"Anthropic's harness grades steps from evidence."~~ **False.** Nothing in the reference grades from
  evidence; the model grades and the harness vetoes.
- ~~"The plan regression is a race."~~ **False** — `onEvent` runs synchronously ahead of the awaited
  resolution and `applyWorkflow` writes the ref synchronously. It is a protocol defect, order-independent.

---

## Part 7 — Open questions

Ranked by how much a wrong answer would cost.

1. **Does Claude Code auto-inject the current task list into each request, or must the model pull it
   via `TaskList`?** Push-vs-pull is the central design question for our step directives and it could
   not be closed from primary sources. The docs confirm read-back tools exist and that tasks "persist
   across context compactions" — which implies *some* carry mechanism — but never state which.
2. **Do our actual Ollama builds accept `role:"tool"` in practice?** Documented for native `/api/chat`
   [D]; untested against what we ship. M3 depends on it. Also untested: whether `tool_call_id` is
   accepted alongside `tool_name`, and whether models behave measurably better with typed results.
3. **Is mid-conversation `role:"system"` available on anything we target besides the Claude API?**
4. **What is the literal wire format of a `<system-reminder>`?** Confirmed that harness text is wrapped
   in one; no doc shows the serialized message.
5. **`tool_choice: {type:"any"}` semantics on Anthropic** — the most obvious API-level alternative to a
   continuation primitive, and its exact behaviour (including the assistant-prefill effect that
   suppresses prose before the tool block) was not verified.
6. **Does text after a tool result actually degrade continuation?** Established: legal for client-only
   turns, a turn-terminator when a server tool is pending, and no system-level priority. The causal
   claim is inferred from the wire contract, not stated anywhere.
7. **Anthropic's current position on decomposition.** *Building effective agents* reportedly now carries
   an editorial note redirecting to Managed Agents docs, which were not fetched. The
   workflows-vs-agents taxonomy may be superseded.

Sources for §5 of the research — the decomposition guidance specifically — are the weakest part of this
document and are marked [D?] throughout. If any of it becomes load-bearing, re-fetch first.

---

## Appendix — smaller findings worth not losing

- `isStallConfirmation` matches the empty string and pure punctuation (`buddy-session.ts:114–121`;
  every regex group is optional). Harmless at its one call site, which special-cases empty, but a
  second caller would read silence as "yes, that was the last one."
- The anti-skip novelty test is round-granular (`buddy-session.ts:991`): a legitimate series that
  repeats a value reads as "no new work" and its check-off is refused.
- `reasoningEffort: "none"` is guarded only by a comment (`buddy-session.ts:699–713`).
- Raw and stripped replies are both persisted — line 934 pushes the unstripped reply (tool JSON
  included) to the transcript; 840 and 925 push the cleaned one. The model's history contains both
  shapes of its own output depending on which branch produced it.
- The worker's tick has **no nudge budget**; the host's is `MAX_STEP_REMINDERS = 3`.
- `workflowToPlan` drops `onFail`, `maxAttempts`, `attempts`, `context`, `inferred` and file paths, and
  `doneWhenToNeeds` returns `undefined` for `files` — so a `files` contract degrades to a re-inference
  on every turn boundary.
- `activePlan` and the Ollama reply grammar are computed **once, before** `runBuddyTurn` — through a
  25-step in-turn run the model's visible checklist keeps saying step 1 is current, and the grammar
  stays pinned to step 1's required tool.
- The wrap-up directive is the one continue-path that is **not** round-guarded, so at the cap the model
  can still be handed a directive advertising `keep_going`, whose calls line 744 then discards.
