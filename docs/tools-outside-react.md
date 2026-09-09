# Declaring tools outside React

Some things an agent should be able to do do not live in a component. A logout in a singleton auth
service. A navigation in a router. An action registered before the application mounts at all.

```ts
import { registerMcpTool } from 'agent-mcp-react/actions';

const logout = registerMcpTool({
  name: 'session.logout',
  description: 'Logs out the current user.',
  handler: async () => {
    await auth.signOut();
    return { loggedOut: true };
  },
});
```

Safe at module scope, before React mounts and before any provider exists. The declaration is held and
registered by the next provider that mounts.

## It is a registration API, not a runtime

The original design sketched `createAgentMcpRuntime()` — an application constructing a runtime and
connecting it. **That does not ship, and the reason is worth knowing** because the sketch looks
harmless: a runtime an application constructs is a second MCP server on one page. Two sockets, two
servers, the same tools advertised twice. It does not present as a connection error; it presents as
**every tool call happening twice**.

So there is no `connect`, no `shutdown`, no server and no socket here. One provider claims the
document and remains the only thing that serves. What you get is a place to *declare*.

## "Static" describes ownership, not an exemption

A tool declared this way is an ordinary tool. It registers into the document's tool registry, carries
its own abort controller, has an entry in the ownership record, passes every gate, and is **refused**
— not merely missing — after it is removed. The only thing that differs is who owns it: the
application shell rather than a screen.

Which is exactly why it behaves this way across a provider's lifetime:

| | |
|---|---|
| Provider mounts | Registered |
| Provider **unmounts** | Withdrawn — but the **declaration is kept** |
| Provider mounts again | **Re-registered automatically**, with your code doing nothing |
| `remove()` | Gone for good |

Your shell did not unmount when the provider did, so its tools come back with it. If you want one
gone, say so.

## The handle

```ts
logout.update({ description: 'Ends the current session.' });  // one cycle
logout.update({ description: 'Ends the current session.' });  // nothing at all
logout.remove();                                              // permanent, idempotent
logout.registered;                                            // has a provider taken it?
```

`update()` takes a partial and merges. **A call that changes nothing does nothing** — no registry
operation, no notification to the agent. That matters more than it sounds: calling `update()` from a
store subscription is a reasonable thing to do, and without this it would be a
`tools/list_changed` storm while the tool stayed perfectly correct.

`registered` is reported, never awaited and never thrown about. A declaration made at import time
normally has no provider yet — that is the case this API exists for. But a tool that *never* registers
because no provider ever mounts should not be a mystery, so it is visible here.

**There is no `enable()` or `disable()`.** Availability is per-tool policy declared as a value and
refused at invocation (see [Per-tool permissions](reference-capabilities.md#per-tool-permissions)). A
second switch here could disagree with it, and the disagreement would
be invisible.

## What it does not change

- **No capability of its own.** These are Level 1 tools, in the shared document registry, callable by
  any script on the page, exactly like every other Level 1 tool.
- **No way around the gates.** You get a registration handle, never a runtime. A value that reached
  the runtime would be a value that reached around the gates it holds.
- **No second ownership record, socket or server.** One document, one of each.

## Related

- [Store adapters](store-adapters.md) — Redux, Zustand and router bindings built on this
- [Declaring a tool](declaring-a-tool.md) — the component-owned form, and who on the page can call it
- [Exposing state for inspection](exposing-state.md) — the read half
