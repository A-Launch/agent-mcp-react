# `@agent-mcp/react`

A browser-side React library that exposes a running React application as an MCP server, so an agent
can drive it through typed tools instead of clicking its UI. The one architectural fact everything
follows from: **MCP is a second control interface onto one application** — not browser automation and
not a second store. The human UI and the agent act through the same application state transitions;
the library owns the control plane, the application keeps owning its state.

**Read `CONTRIBUTING.md` before changing anything; it owns every convention in this repository.**
Where a rule appears both here and there in different words, that is a defect — report it.

## The gate

```bash
pnpm gate
```

Run it after any change under `src/`, `examples/` or `tools/`. What it runs is in `package.json`.
Three more runs are manual and are listed in
[CONTRIBUTING.md](CONTRIBUTING.md#3-the-gate).

## What fails quietly here

Each of these produces a call that succeeds while the application is wrong. None is caught by a type.
The sentences are the contributor guide's own, so the two documents cannot drift apart; each links the
section that explains it.

1. **Never expose a tool the application did not explicitly register.** No scanning, no convention, no
   inference from a store shape or a route table.
   → [CONTRIBUTING.md](CONTRIBUTING.md#9-forbidden-patterns)
2. **Never register during render.** Registration is an effect, after commit; an aborted render must
   expose nothing. → [CONTRIBUTING.md](CONTRIBUTING.md#9-forbidden-patterns)
3. **Never validate inside the handler.** Schema and policy run in the runtime, before invocation.
   → [CONTRIBUTING.md](CONTRIBUTING.md#9-forbidden-patterns)
4. **Never resolve a tool call before the application accepted the mutation**, and never assert that
   effects completed because a frame elapsed.
   → [CONTRIBUTING.md](CONTRIBUTING.md#9-forbidden-patterns)
5. **Never enable `evaluate`, or widen a capability, to make something work.** That is the one change
   whose blast radius is the whole page. → [CONTRIBUTING.md](CONTRIBUTING.md#9-forbidden-patterns)
6. **Never add a `setTimeout`, extra `requestAnimationFrame` or widened `waitFor` to make a flaky test
   pass.** Establish the synchronization the mechanism actually needs.
   → [CONTRIBUTING.md](CONTRIBUTING.md#9-forbidden-patterns)

## Before debugging

Read [docs/troubleshooting.md](docs/troubleshooting.md). The failures in this system point at the
wrong cause more often than not, and that page carries the symptoms by layer and the diagnostic
order.
