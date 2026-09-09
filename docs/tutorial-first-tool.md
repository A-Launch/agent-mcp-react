# Tutorial: your first agent-callable tool

You will take a plain React counter and make it drivable by an agent. By the end you will have
called a tool from your browser's console and watched the page change — with no server, no
credentials, and no agent runtime.

Then you will connect a real agent to the same tool, unchanged.

Every command and output below was run against this library. If a step does not produce what it
says, that is a defect worth reporting.

## What you'll need

- Node 22 or newer, and a React 18+ app that builds. A fresh Vite app is fine:
  `pnpm create vite my-app --template react-ts`
- A browser from the support floor: Chrome 116+, Safari 17.4+, or Firefox 124+
- About fifteen minutes

You do **not** need an agent, an API key, or a backend.

## Step 1: Install

If the package is published:

```bash
pnpm add @agent-mcp/react
```

If you are working from a checkout, pack it and depend on the tarball — the route that behaves the
same on every package manager:

```bash
pnpm pack        # in the library checkout → agent-mcp-react-0.2.0.tgz
```

```jsonc
// your app's package.json
{ "dependencies": { "@agent-mcp/react": "file:../agent-mcp-react/agent-mcp-react-0.2.0.tgz" } }
```

A `file:` dependency on the **directory** does not work. The reason, and the other routes, are in
[consuming-without-publishing.md](consuming-without-publishing.md).

## Step 2: Wrap your app in the provider

The provider owns the connection and the capability gate. It takes four required props.

```tsx
// src/main.tsx
import { AgentMcpProvider } from '@agent-mcp/react';
import { createAjvValidator } from '@agent-mcp/react/validation';
import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { Counter } from './Counter';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AgentMcpProvider
      // Nothing is listening yet. That is fine — the page works before the socket does,
      // and you will point this somewhere real in Step 5.
      connection={{ getUrl: async () => 'ws://localhost:45000/socket?ticket=dev' }}
      server={{ name: 'my-app', version: '0.1.0' }}
      // Every member is required. An omitted one would be a value nobody wrote.
      capabilities={{
        application: true,
        dom: { inspect: false, interact: false },
        evaluate: false,
      }}
      onUnexpectedState={(failure) => console.error('[mcp]', failure)}
      validation={{ validator: createAjvValidator() }}
    >
      <Counter />
    </AgentMcpProvider>
  </StrictMode>,
);
```

Run your dev server. **The page renders exactly as before.** The console shows a failed WebSocket
connection, because nothing is listening — that is expected and does not affect the page.

> `createAjvValidator` compiles schemas with `new Function`, so it needs CSP `unsafe-eval`. If your
> app ships a strict `script-src`, read [the defect record](issues/validator-requires-unsafe-eval.md)
> before going to production.

## Step 3: Declare a tool

Declare it in the component that owns the state. The tool exists while that component is mounted.

```tsx
// src/Counter.tsx
import { useMcpTool } from '@agent-mcp/react';
import { useState } from 'react';

export function Counter() {
  const [count, setCount] = useState(0);

  useMcpTool({
    name: 'counter.increment',
    title: 'Increment the counter',
    description: 'Adds the given amount to the counter shown on the page.',
    inputSchema: {
      type: 'object',
      properties: { by: { type: 'number', description: 'How much to add.' } },
      required: ['by'],
      additionalProperties: false,
    },
    handler: (input) => {
      const by = input.by as number;
      setCount((previous) => previous + by);
      return { added: by };
    },
  });

  return (
    <main>
      <p>count: {count}</p>
      <button type="button" onClick={() => setCount((n) => n + 1)}>+1</button>
    </main>
  );
}
```

**The handler does not validate `by`.** It does not have to: the schema is enforced in the runtime
before the handler runs, so a call with a missing or non-numeric `by` is refused and your code never
sees it.

Note what the tool calls: `setCount`, the same state transition the button uses. That is the whole
idea. The agent and the person act through the same path.

## Step 4: Call it, and watch the page change

Open the page, open your browser's console, and paste this:

```js
const mc = document.modelContext;
const tool = (await mc.getTools()).find((t) => t.name === 'counter.increment');
await mc.executeTool(tool, JSON.stringify({ by: 7 }));
```

The counter jumps from `0` to `7`, and the console prints the handler's return value:

```
'{"added":7}'
```

**That is the whole product in four steps.** Your tool is registered in the browser's own per-document
tool registry, so any script on the page can list and call it — which is exactly what a browser-native
agent will do, and why you did not need a server to see it work.

Two things worth trying now, because both teach something:

```js
// A bad argument is refused BEFORE your handler runs.
await mc.executeTool(tool, JSON.stringify({ by: 'lots' }));

// So is a missing one.
await mc.executeTool(tool, JSON.stringify({}));
```

Neither reaches `handler`. You wrote no checks to get that.

## Step 5: Connect a real agent

Everything so far went through the page's own registry. An **external** agent reaches your tools over
an authenticated WebSocket instead, and this is the part your backend owns.

The provider takes a **function**, never a credential:

```tsx
connection={{
  getUrl: async () => {
    const { url } = await fetch('/api/mcp-ticket', { method: 'POST' }).then((r) => r.json());
    return url;    // opaque to the library: never parsed, never amended, never stored
  },
}}
```

`getUrl` is called once per connection attempt, so every attempt gets a fresh, single-use credential.
Your side of that is three pieces: a **ticket minter** on your backend, a **WebSocket gateway** that
checks the ticket and relays MCP, and the **agent runtime** holding the MCP client.

`tools/mock-agent/` in this repository implements all three for local development — start it with
`pnpm dev:agent`, then have `getUrl` fetch `http://localhost:45000/ticket` and dial the `wsUrl` that
comes back, which already carries a freshly minted, single-use ticket. It is not a production
component.

The full contract, including what happens when a ticket is refused and how reconnection behaves, is in
[connecting-to-an-agent.md](connecting-to-an-agent.md).

## What you built

A React component whose state an agent can change through a typed, validated, named action — reachable
both by a browser-native agent through the page and by an external agent over an authenticated socket,
with the same declaration serving both.

You also saw the three guarantees that make this different from browser automation:

- **The tool exists only because you declared it.** Nothing scanned your code or guessed from a store.
- **Validation runs before your handler**, in the runtime, so every caller gets the same treatment.
- **The agent calls the same transition the button calls**, so there is no second path into your state.

### Where to go next

| If you want | Read |
|---|---|
| Everything `useMcpTool` accepts, and what a rerender costs | [declaring-a-tool.md](declaring-a-tool.md) |
| To let an agent read state as well as change it | [exposing-state.md](exposing-state.md) |
| To declare tools outside React | [tools-outside-react.md](tools-outside-react.md) |
| To bind Redux, Zustand or a router | [store-adapters.md](store-adapters.md) |
| The complete export surface | [reference-api.md](reference-api.md) |
| To wire the socket properly | [connecting-to-an-agent.md](connecting-to-an-agent.md) |
