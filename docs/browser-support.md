# Browser support — what is verified, and what is not

**Read the second table before quoting the first.** This page states the verified set and the gap
together, deliberately, because a support claim separated from its limits is how a gap becomes a false
claim.

## What the design asks for

```text
Chrome / Edge : current and previous 2
Firefox       : current and previous 2
Safari        : current and previous 2
```

Required APIs — each asserted individually by the end-to-end suite:

| API | Why this library needs it |
|---|---|
| `WebSocket` | the browser is the MCP server and dials outbound (see [direction](websocket-framing.md#direction)) |
| `crypto.randomUUID` | one page instance mints one identity (see [page identity](design.md#page-identity)) — **unavailable in an insecure context** (see [the platform preconditions](#two-platform-preconditions) below) |
| `Promise` | every tool call settles asynchronously |
| `Map` | the ownership record and the built-in table are keyed lookups |
| `AbortController` | a registration ends by aborting its signal (see [registration follows the commit](design.md#registration-follows-the-commit)); a call is cancellable (see [cancellation](design.md#cancellation)) |
| `AbortSignal.any` | a call ends for two reasons and a handler must learn both through **one** signal (see [cancellation](design.md#cancellation)) |

`AbortSignal.any` sets the engine floor: **Chrome 116, Safari 17.4, Firefox 124.**

## What has actually been run

The end-to-end suite runs the **same cases** on three engines — no reduced set for the shim path,
because the design gives the shim path *"the same test obligation as any first-class path"*, and Firefox
and WebKit both take it.

| Engine | Result |
|---|---|
| Playwright Chromium | 19/19, with 1 skipped |
| Playwright Firefox | 19/19, with 1 skipped |
| Playwright WebKit | 19/19, with 1 skipped |

Measured 2026-09-09: 20 cases declared per engine, of which the strict-CSP evaluation case is skipped
unless the run is invoked with `AMR_CAPABILITIES_PROFILE=evaluate` and the dashboard is served to match.
The suite prints the engine revision it ran on, so the version belongs in the run's own output rather
than in a table that ages; read it there.

**One caveat, recorded rather than smoothed over.** A full run is intermittently red through a defect in
the harness, not in the library: the three engines run the same file at once against one mock agent, and
one case requires the agent to report exactly one connected page.
[The defect record](issues/e2e-tab-selection-races-across-engines.md) has the cause and the two
candidate fixes. The figures above are from a run that did not hit it.

**This is the only evidence that the portability shim works in a real browser.** Every other test in
this repository runs in jsdom or in one Chromium.

## What that does NOT evidence

Three things, and none of them is a technicality:

1. **Playwright's Chromium is not Chrome, and it is not Edge.** It is a Chrome for Testing build.
2. **Playwright's WebKit is not Safari.** It is the WebKit engine without Safari's own layer.
3. **None of them can be pinned to "current and previous 2".** Playwright ships one revision per
   engine per release.

So the claim this repository is entitled to make is:

> The suite passed on the Playwright-bundled Chromium, Firefox and WebKit revisions named above, and
> all six required APIs were present in each.

**The browser matrix above remains a support _target_, not verified support.** It is not marked satisfied.

## What would close it

The same suite on real browser releases — twelve runs, recording version, OS, date and result:

| | current | −1 | −2 |
|---|---|---|---|
| **Chrome** | ☐ | ☐ | ☐ |
| **Edge** | ☐ | ☐ | ☐ |
| **Firefox** | ☐ | ☐ | ☐ |
| **Safari** | ☐ | ☐ | ☐ |

That needs real machines or a browser service. It is an operator's decision about infrastructure, not
something a feature can decide for them.

## Two platform preconditions

Neither is something this library can work around, and neither is a defect to route around.

- **A secure context is required.** The registry attribute is defined only in one, and this library
  declines to install the shim outside one. On an insecure origin the library fails to start with
  `MCP_REGISTRY_INSECURE_CONTEXT` rather than silently exposing nothing. `localhost` is a secure
  context, so local development is unaffected — and the e2e suite asserts `isSecureContext` so a run
  against a plain-HTTP origin fails there, with a cause, rather than as a puzzling registry failure.
- **The registry is gated by Permissions Policy**, under a feature whose default allowlist is `['self']`.
  This library relies on that default and never requests delegation.

## Running it yourself

```bash
pnpm dev:agent                                  # :45000
AMR_CAPABILITIES=developer pnpm dev:example     # :45010
pnpm dev:board                                  # :45030
pnpm test:e2e
```

`pnpm test:e2e` is **not** part of `pnpm gate`. It needs three dev servers and browser binaries, and a
gate command that needs setup is a gate that gets skipped.
