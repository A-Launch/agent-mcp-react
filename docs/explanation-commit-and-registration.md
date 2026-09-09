# Why a tool appears after the commit, and a call waits for one

Two timing rules that look like implementation detail and are not. Both exist because React renders
optimistically and an agent believes what you tell it.

## The problem: a render is not a commit

React can render a component and throw the result away. A render can be interrupted, abandoned,
retried, or run twice on purpose in StrictMode. Suspense can start rendering a subtree that never
appears. Concurrent rendering can start work, discard it, and start again.

Two things go wrong if you ignore that.

**Registering during render exposes tools for a UI that does not exist.** A component that registered
`invoice.mark_paid` while rendering, in a subtree that then suspended, has published a tool for an
invoice nobody is looking at. The agent calls it, and either the handler operates on state that was
never shown or it throws in a way nobody can explain. In StrictMode you get it twice.

**Returning after dispatch reports a success that has not happened.** This one is worse because it
looks fine:

```ts
// wrong
handler: async (input) => {
  setFilters(input);
  return { matched: visibleRows() };   // reads the PREVIOUS render
}
```

`setFilters` schedules. It does not apply. `visibleRows()` runs before React committed anything, so the
number returned is the one from before the call. The agent is told 48 while a person reads 7. Nothing
errors, no test fails, and the two observers of one application now disagree.

## The approach

**Registration happens in an effect, after commit.** Effects run only for renders that actually
committed. An aborted or suspended render exposes nothing, and StrictMode's double-invocation is
symmetric — register, withdraw, register — so nothing leaks.

**A handler waits for the commit before it returns.** `context.afterRender()` is the barrier:

```ts
handler: async (input, context) => {
  setFilters(input);
  await context.afterRender();
  return { matched: visibleRows() };   // now reads what the person sees
}
```

### What `afterRender` promises, and what it does not

It resolves after **a React commit that includes everything scheduled before you called it, and that
commit's passive effects**. That is the whole promise, stated narrowly on purpose.

It does **not** cover work you schedule from inside those effects — a fetch, a timer, an animation,
another dispatch. If your handler needs one of those to finish, wait for the thing itself; a barrier
that claimed to cover arbitrary async work would be a barrier that lies.

It is deliberately **not** `requestAnimationFrame`. A frame has no defined relationship to a commit: on
a busy page it can elapse before one, or long after the effects. A tool that resolved on a frame would
be right most of the time, which is the worst possible property for a synchronisation primitive.

### Why the handler is read at invocation

The registered callback is stable for the tool's whole lifetime and reads the latest handler through a
ref. Without that, every call would close over the render that registered it: the agent sets a filter,
the tool reports success, and the value it applied came from three renders ago.

This also means a rerender whose descriptor is unchanged **touches the registry not at all**. That
matters more than it sounds: the standard has no update operation, so a descriptor change is a
withdraw-and-register cycle. Doing that on every render would give the agent a
`tools/list_changed` storm and a window, on every keystroke, in which the tool does not exist.

The rule that follows for your code: **make a descriptor depend only on identity, never on state.**

```ts
// good — the descriptor depends on the panel's immutable id
name: `panel.${panel.id}.set_sort`,
description: `Sorts the "${panel.id}" table.`,

// bad — every sort becomes a withdraw-and-register cycle
description: `Sorts the table, currently by ${settings.column}.`,
```

## What this costs

**Your handler must be `async` and must remember the barrier.** Nothing forces you to call
`afterRender()`. A handler that skips it still compiles, still passes a test that only checks the
return value, and still lies to the agent. This is the defect a real transport gives cover to: a socket
round trip gives React more than enough time to commit, so the bug disappears exactly when you test it
end to end.

Which is why the integration suites here assert **agreement** — that what the tool reported and what
the screen shows are the same — rather than asserting the outcome. A DOM assertion can see "the UI
never updated". It cannot see "the UI updated late", and late is the defect. Waiting longer makes it
less visible, not more. Deleting every `afterRender()` from this repository's demonstrator once left
every case green.

**A tool is unavailable for a moment after mount.** Between the commit and the registration completing
there is a window where the tool is not yet listed. It is small and it is real; the honest response is
to let the agent re-list rather than to pretend otherwise.

**A descriptor that genuinely changes costs one cycle.** There is no `update()` in the standard to fall
back on, so a real change — a new schema, a new description — is one withdraw and one register, and the
agent sees one change notification. That is the floor, not an inefficiency.

## Related

- [Declaring a tool](declaring-a-tool.md) — the full contract, including `afterRender`'s exact wording
- [Why this is a second control interface](explanation-second-control-interface.md)
- [Exposing state](exposing-state.md) — the read side, and why a state change notifies nobody
- [Observing tool calls](observing-tool-calls.md) — watching a call settle
