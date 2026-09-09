*Dated material — a defect record, written 2026-09-09 and describing that moment; current behaviour is in the pages under docs/.*

# The end-to-end suite races itself across engines

**Status: FIXED 2026-09-09.** Cause established, the better of the two fixes taken, and the failure
reproduced deterministically before and after. It was a defect in the test harness, not in the
library: nothing here says the library misbehaved.

## What is seen

`pnpm test:e2e` fails intermittently, in `tests/e2e/composable-board.spec.ts`, on whichever engine
loses the race. Two shapes, both from the same cause:

```
Error: waited for exactly one READY tab and never saw it — the agent reports
  [{"tabId":"8aaad9a9-…","state":"ready"},{"tabId":"7bf4a73c-…","state":"ready"}]

SyntaxError: Unexpected token 'M', "MCP_TOOL_N"... is not valid JSON
```

The second is the first one step later: the case addressed the other engine's page, which has no
`board.add_panel`, so the refusal text arrived where the case expected a JSON result.

Observed on 2026-09-09 over three consecutive full runs: one failure on WebKit, one run with a
failure on WebKit and another on Firefox, one run entirely green. The same file passes on WebKit
three times out of three when run alone.

## The cause

The suite reads the mock agent's tab list to learn which page is its own, and
`tests/e2e/composable-board.spec.ts` requires **exactly one** ready tab before it addresses a call.

The file already guards the obvious half. It declares `test.describe.configure({ mode: 'serial' })`,
and its comment says why: two cases connecting at once would each see the other's page. That guard is
correct and it holds.

What it does not cover is everything **outside the file**. `playwright.config.ts` sets
`fullyParallel: true`, so within one project different spec files run at the same time, and it declares
chromium, firefox and webkit as three projects, which Playwright runs concurrently as well. Six spec
files open a page, and every one of them points at the same mock agent on `:45000`, whose tab list is
global. So a page belonging to another file or another engine is connected while this case is asking,
and "exactly one ready tab" is false through no fault of any case. Serial mode inside one file cannot
see either kind of neighbour.

The window is small, which is why the suite is usually green: it is the gap between one engine's page
completing MCP initialization and that engine's case finishing with it.

## The fix

Two were available. **Serializing every case that touches the agent** — across files and across
projects, not merely within a file — is the blunt one, and it costs most of the suite's parallelism
while leaving every case still reasoning about a list that is not its own.

What was taken instead is **scoping tab selection to the page under test**. The page already mints an
identity per instance; the two demonstrators now publish it as `data-tab-id` on their connection
indicator, and `tests/e2e/tab.ts` reads it from the page and waits for the agent to report *that* tab
ready. Nothing asserts anything about any other tab, so a neighbouring spec file or a second engine
changes nothing.

That removes the question rather than answering it more carefully. "Exactly one ready tab" is no
longer required anywhere, and the case that deliberately connects a second demonstrator no longer needs
the global count to be two — it waits for the second page's own tab instead. `tab.ts` is the single
owner of "which tab is mine": `csp-evaluate.spec.ts` had answered it a different way, by taking the
difference between two reads of the global list, which attributes to itself any page a neighbour
connected in the window between them. Both specs now ask the same question of the page.

Serial mode stays in `composable-board.spec.ts`, because those cases build on one another's state. It
is no longer a guard against addressing the wrong page, and its comment says so.

## How it was proved

The intermittency was removed from the proof. A neighbour page was held connected for the whole run,
which is the condition that used to arrive by luck:

| Under one connected neighbour | Result |
|---|---|
| With the fix | 57 passed, 3 skipped, exit 0 |
| With the old "exactly one READY tab" restored | **3 failed**, 45 passed, exit 1 |

The failures name themselves: `waited for exactly one READY tab`. Five consecutive full runs with the
fix and no neighbour were also green, where two of three had failed before it.

## What must not be done

Adding a retry, widening a timeout, or relaxing "exactly one" to "at least one" would each have turned
the suite green while leaving a case able to address a page it did not open — which is the failure the
guard existed to catch, and the shape this project treats as a defect rather than a flake. None was
done. The guard was replaced by one that cannot be raced, not loosened.

## How to reproduce

Start the three dev servers, then run the full suite repeatedly:

```bash
pnpm dev:agent & pnpm dev:example & pnpm dev:board &
for i in 1 2 3; do pnpm test:e2e; done
```

Two of the three full runs recorded on 2026-09-09 failed, and one was green.
`pnpm exec playwright test --project=webkit tests/e2e/composable-board.spec.ts` passed on all three
isolated runs it was given — one project running one file has no neighbour to race, though three runs
are evidence about those runs rather than a guarantee.

To reproduce it deterministically rather than waiting for the race, hold one demonstrator page
connected for the duration of the run: with the old mechanism every case that asked for "exactly one
READY tab" then fails on the first attempt.
