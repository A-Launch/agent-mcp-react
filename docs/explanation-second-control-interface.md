# Why this is a second control interface, not browser automation

Two ways to let an agent operate a web application. This library takes the second, and almost
everything else about it follows from that choice.

## The problem

An agent needs to do something in your application: set a filter, mark an invoice paid, create an
account. The obvious approach is to drive the UI — find the button, click it, type in the field. That
is browser automation, and it has three failure modes that never go away.

**It breaks on things that are not changes.** Rename a CSS class, reorder two columns, move a button
into a menu. Nothing about the application's behaviour changed and every script that drove it is now
wrong. The agent was coupled to the *rendering*, which is the layer that changes most often and is
supposed to.

**It cannot tell success from the appearance of success.** A click dispatches. The handler may not
have run — `disabled`, `inert`, `pointer-events: none`, an overlay, a race with a re-render. Automation
sees a click that "worked". The strongest thing it can then do is look at pixels and guess.

**It has no boundary.** Anything a person can reach, the script can reach, because it *is* the person's
interface. There is no way to say "this agent may filter customers but may not delete them" other than
hoping it doesn't find the button.

## The approach

The application declares what an agent may do, in its own vocabulary, and the agent calls that:

```tsx
useMcpTool({
  name: 'customers.set_filters',
  inputSchema: { /* … */ },
  handler: async (input, context) => {
    setFilters(input);              // the same function the toolbar calls
    await context.afterRender();    // resolve only once the page committed it
    return { matched: visibleRows() };
  },
});
```

The agent and the human UI act through **the same application state transitions**. Not a parallel path,
not a second store — the same function, reached two ways.

```
        person                             agent
          │                                  │
     click / type                    tools/call over MCP
          │                                  │
          ▼                                  ▼
    ┌───────────────────────────────────────────────┐
    │              your application                 │
    │        setFilters() · markPaid() · …          │
    └───────────────────────────────────────────────┘
                          │
                     one state change
                          │
                          ▼
                    the rendered UI
```

What that buys, point for point against the three failures above:

- **Renaming a class breaks nothing.** The contract is the tool's name and schema, which you chose and
  which changes when the *behaviour* changes.
- **A call resolves only after the application accepted the mutation** — see
  [why a call waits for the commit](explanation-commit-and-registration.md).
- **There is a boundary, because there is a declaration.** A tool exists only by registration. No
  scanning, no convention, no inference from a store shape or a route table. An agent cannot reach an
  action nobody instrumented, which is the whole reason the [capability model](reference-capabilities.md)
  can mean anything.

## The browser is the MCP server, and it dials out

The second structural choice, and the surprising one: **your page is the MCP server**, and it opens an
outbound WebSocket to the agent runtime.

Written the other way round — agent connects to browser — it cannot work:

- A browser tab has no address. There is nothing to connect *to*: no port, no hostname, no route
  through the user's NAT and firewall.
- A tab's lifetime is a person's attention. It closes, reloads, navigates and sleeps. A server that
  disappears when someone switches tabs is not a server anyone can call.
- The tools *live* in the page. They are declared by components that are mounted right now, so the
  authoritative tool list exists only where the rendering does.

So the page dials out, and what it exposes over that socket is an ordinary MCP server:
`tools/list`, `tools/call`, `notifications/tools/list_changed`. The agent runtime holds the MCP
**client**, because that is where the socket it accepted is held.

Two consequences you will meet in practice:

- **Your application supplies the connection URL, per attempt.** The library takes a `getUrl` function
  and never a credential, so nothing it holds can leak one. A fresh credential is obtained *after* any
  backoff wait, never before — both orderings satisfy "a fresh credential per attempt" and they behave
  identically until the schedule's maximum, where the interval is 30 s and a recommended credential
  lifetime starts at 30 s. It fails at exactly the step a real gateway restart drives you to.
- **The agent is notified, not polled.** A change to the agent-visible tool set sends
  `notifications/tools/list_changed`; a change that does not affect it — a rerender, a handler-only
  edit, another script's registration in the shared registry — sends nothing.

## Trade-offs

Naming what this costs, because every design gives something up.

**You have to instrument.** An agent can only reach what you declared. That is the point, and it is
also work: a flow nobody wrapped in a tool is a flow the agent cannot drive. The escape hatch is
[Level 2, semantic DOM control](dom-inspection.md) — a fallback for uninstrumented flows, experimental,
and a DOM tool for a flow that already has an application tool is a regression rather than a
convenience.

**The page must be open.** No tab, no server. This drives an agent that acts *with* a person present,
not a headless batch job. If you need the batch job, you need a backend API, and you always did.

**One provider per document.** Two would be two MCP servers on one page, which presents as every tool
call happening twice rather than as an error. The library claims the document and refuses a second
claim (`MCP_REACT_PROVIDER_ALREADY_ACTIVE`).

**Your tools are in the page's shared registry.** They live in `document.modelContext`, which every
script on the page can enumerate and invoke. Capabilities gate *this library's bridge*, not your page —
the single most misread property of the model, and it has its own section in
[what an agent can reach](explanation-reachability.md#a-capability-governs-the-bridge-not-your-page).

## Related

- [Tutorial: your first agent-callable tool](tutorial-first-tool.md)
- [Connecting to an agent](connecting-to-an-agent.md) — the socket, tickets, and the connection lifecycle
- [Why a call waits for the commit](explanation-commit-and-registration.md)
- [What an agent can reach](explanation-reachability.md)
- [The composable board](composable-board.md) — a demonstrator built entirely on this shape
