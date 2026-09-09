*Dated material — a measurement taken on 2026-08-27; current behaviour is in the pages under docs/.*

# Performance budgets — measured

Measured 2026-08-27, when the end-to-end suite first ran on three engines. **Every one of these was a
prose claim until then.** The budgets themselves are the design's: a main entry under 50 KB gzip, a
500-tool registry that stays functional, no polling when idle, tool-invocation overhead under 5 ms,
O(1) registration and no React rerender caused solely by an MCP request.

Reproduce the size figures with `node scripts/measure-bundle.mjs`; the timing and capacity
figures with `pnpm test:transport tests/transport/budgets.spec.ts`.

## Size (budget: under 50 KB gzip, initial runtime overhead)

```text
size budget — measured

  source revision : 9f1d610
  esbuild         : 0.28.2
  node            : v24.19.0
  gzip            : zlib level 9
  external        : react, react/*, react-dom, react-dom/*, @modelcontextprotocol/server, @modelcontextprotocol/server/*

  per subpath (gzip):
    .                27.0 KB   (raw 89.4 KB)
    ./dom             5.7 KB   (raw 15.1 KB)
    ./devtools        3.3 KB   (raw 8.2 KB)
    ./evaluate        1.9 KB   (raw 4.0 KB)
    ./router          1.4 KB   (raw 2.8 KB)
    ./redux           1.4 KB   (raw 2.8 KB)
    ./zustand         1.4 KB   (raw 2.8 KB)
    ./actions         1.2 KB   (raw 2.4 KB)
    ./validation      0.8 KB   (raw 1.5 KB)

    ALL EXPORTS      35.9 KB   (raw 115.7 KB)

  BUDGET: 50.0 KB gzip, initial runtime overhead
  PASS/FAIL is the MAIN ENTRY — "initial" is what an embedder pays by default, and the
  clause already excludes the optional schema library. Levels 2 and 3 are optional in
  exactly that sense, measured: neither reaches a bundle that does not import it.

  main entry: 27.0 KB / 50.0 KB  →  WITHIN BUDGET
```

**Both numbers pass**, which makes the choice of pass/fail figure moot in the best way. The spec
departs from an external consult by making the MAIN ENTRY the pass/fail number and publishing the
all-exports total beside it — and at 27.0 KB and 35.9 KB respectively, the argument never has to
be relied on.

**The budget's two exclusions turn out to be one, discovered by running this rather than by reading the
manifest.** The clause excludes "the MCP SDK and optional schema library" as though they were two
payloads. Ajv is not a dependency of this package at all — the validation adapter imports it from
`@modelcontextprotocol/server/validators/ajv`. Externalizing the SDK excludes both, structurally.
Confirmed: the only occurrence of "ajv" in the measured main bundle is inside an error message
telling an author which module to import.

So `./validation` at 0.8 KB is the ADAPTER GLUE — this library's own error-message composition
and its boundary onto a validator — not a schema engine that was quietly subtracted.

## Capacity and timing

| Budget clause | Measured |
|---|---|
| "a tool registry containing 500 tools MUST remain functional" | 500 registered; `tools/list` returns all 500; the **last** one is callable and answers correctly |
| "no polling when idle" | **0** outbound frames across a 750 ms idle interval on a connection that is still live afterwards |
| "tool invocation overhead under 5 ms excluding application handler execution" | **0.34 ms** per call over 50 calls — and this is an **upper bound**, because it includes the socket round trip and the protocol layer, neither of which the budget counts |

## What is NOT measured here

- **"registration/unregistration O(1) average"** — asserted by the shape of the ownership record
  (a `Map`) rather than by a timing curve. A microbenchmark asserting a complexity class would be
  the first flaky case in this repository, and the budget gives it no threshold to hold to.
- **"no React rerender caused solely by an MCP request"** — already measured on 2026-08-24, when the
  render barrier landed, with its narrow exception for a handler that awaits the render barrier (see
  [a call settles after the commit](../design.md#a-call-settles-after-the-commit)). It is not
  re-measured.
- ~~A production build~~ — **taken the same day, against the built artifact, and the numbers are
  IDENTICAL**: 27.0 KB main entry, 35.9 KB all exports. That is worth recording rather than treating
  as a formality, because it means the source-based method above was not an approximation of the
  shipped figure — it was the shipped figure. `measure-bundle.mjs` now prefers `dist/` when a build
  exists and says which it measured.
