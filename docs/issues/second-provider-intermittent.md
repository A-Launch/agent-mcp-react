*Dated material — a defect record describing what was seen on one run; current behaviour is in the pages under docs/.*

# `second-provider` failed once and did not reproduce

**Status: OPEN — cause not established.** Recorded rather than dismissed, because eight green runs
after one red is not evidence that nothing is wrong; it is evidence that whatever it was is rare.

## What was seen

Date: 2026-08-26, during the a11y and observability work on `develop`.

One run of `pnpm test` reported:

```
× a second provider in one document > is refused, and the refusal names the active holder
 Test Files  1 failed | 81 passed (82)
      Tests  1 failed | 615 passed (616)
```

## What was established

- **It does not reproduce.** The spec passes in isolation, and eight consecutive full-suite runs
  immediately afterwards were green at 616.
- **No assertion error was captured.** Grepping the failing run for `AssertionError` found nothing,
  which is unusual: the failure may have arrived as an unhandled error rather than a failed
  expectation. `tests/react/second-provider.spec.tsx` deliberately provokes a
  `WebMcpBoundaryError` (`MCP_REACT_PROVIDER_ALREADY_ACTIVE`) into an error boundary, so an
  escaping rejection is a plausible shape for the failure.
- **The changes in flight are an unlikely cause but are not excluded.** The only `src/` change in
  that working tree was the refusal funnel in `src/runtime/invocation.ts`, which concerns how a
  refused call records its failure code. The failing case is about the one-provider-per-document
  claim and does not refuse a call. No mechanism connecting them has been identified.

## What was NOT established

- Whether it predates the changes in flight. The suite was not run repeatedly against the prior
  commit for comparison.
- Whether it depends on file execution order or on parallelism between test files.
- What the actual failure text was. The output was not captured before the run was repeated, which
  is the mistake to avoid next time: capture the full output of a red run BEFORE re-running.

## What to do when it recurs

Capture the whole run output first. Then check whether the provider claim from a previous file
survived into this one — `clearRegistry()` and the document claim are the shared state most likely
to leak between files, and a claim released asynchronously would produce exactly this: a case that
passes alone and fails behind a neighbour.


## A related sighting, and what it is not

On 2026-08-28 a different intermittent failure was caught and **fixed**:
[a random port containing `401`](port-number-matched-an-auth-pattern.md).

**It is not evidence about this one** — different file, different signature, and its cause is fully
established while this one's is not. It is recorded here only because it repeats this issue's own
lesson: the failure text was allowed to scroll past on first sighting, and a second occurrence was
needed before it could be identified. Capture the output.
