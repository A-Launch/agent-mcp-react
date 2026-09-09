*Dated material — a defect record, written 2026-09-09 and describing that moment; current behaviour is in the pages under docs/.*

# The end-to-end suite races itself across engines

**Status: OPEN — cause established, fix not chosen.** It is a defect in the test harness, not in the
library: nothing here says the library misbehaves.

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

## Why it is not fixed here

Two fixes are available and choosing between them is a decision about how this layer runs, not a
correction to a claim:

- **Serialize every case that touches the agent** — across files and across projects, not merely
  within a file. Serializing the three projects alone does not close it: two spec files in one project
  still connect at once. This is the blunt fix, and it costs most of the suite's parallelism.
- **Scope tab selection to the page under test** — have each case identify its own tab rather than
  asserting anything about the global list. The page already mints an identity per instance, so a case
  can read that identity from its own page and address it; "exactly one ready tab" then stops being
  required at all, and the case that deliberately connects a second demonstrator stops needing the
  global count to be exactly two. This is the better fix and the larger one.

Neither is a change to the library. Both belong to whoever next touches the end-to-end harness.

## What must not be done

Adding a retry, widening a timeout, or relaxing "exactly one" to "at least one" would each turn the
suite green while leaving a case able to address a page it did not open — which is the failure this
guard exists to catch, and the shape this project treats as a defect rather than a flake.

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
