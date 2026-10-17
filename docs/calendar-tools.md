# Calendar arithmetic in chat

`date_math` is an offline, always-on tool in main chat and Creative mode (native
tools and text/grammar paths), and in book chat (text tool protocol). It never
reads or writes Google Calendar or a scheduled task. Those actions still require
their own tools and completion evidence.

Use `YYYY-MM-DD` or `today`, `tomorrow`, `yesterday`. Relative dates use the local
calendar of the desktop executing the chat, with one clock captured per turn.
Elapsed days use UTC representations of those calendar dates so daylight-saving
changes do not cause fractional-day errors. ISO datetimes use their written date,
not a conversion into another timezone.

Examples:

```json
{"tool":"date_math","op":"diff","from":"2026-06-30","to":"2026-10-18"}
{"tool":"date_math","op":"day_number","from":"2026-06-30","to":"2026-10-18","startDay":1}
{"tool":"date_math","op":"add","date":"today","days":1}
{"tool":"date_math","op":"weekday","date":"tomorrow"}
```

The first returns **110 elapsed days**. The second returns **Day 111** because
June 30 is assigned Day 1. Its answer already includes the anchor: do not add 1
again. `startDay` is required for anchored counts and may be another whole number.
`to` defaults to today; `date` defaults to today for add/weekday. `days` is required
for add and must be a whole number (negative offsets move backwards).

Invalid operations, missing required arguments, fractional offsets, impossible
dates, malformed date prefixes, and dates outside years 0001–9999 are rejected,
not silently rounded or rolled into another month. Retry with corrected arguments.
The normal calculator rejects ISO-looking date expressions: subtracting
`(2026-10-18) - (2026-06-30) + 1` as arithmetic produces 9, not a calendar answer.

Calendar-calculation checklist steps require a successful `date_math` result;
prose, a normal calculator result, or a failed/missing date result cannot complete
them. Pending steps previously tagged `needs: "calculate"` are corrected when
their workflow is compiled. This does not rewrite stored tasks or retroactively
rerun completed steps. Date results cross the worker/mobile bridge and appear as
calendar-result chips in both chats.

## Verification

`date-routing.test.ts` covers both parsers, schemas/grammar, main/book/Creative
loops, calculator recovery, workflow evidence, and the display/worker bridge.
`date-math.test.ts` covers calendar arithmetic, leap years, and DST boundaries.

Optional real local inference (does not save files, chats, or calendar events):

```powershell
$env:DATE_TEST_MODEL = 'your-installed-ollama-model'
pnpm.cmd exec vitest run packages/core/src/chat/date-routing.local.test.ts --maxWorkers=1 --minWorkers=1
```
