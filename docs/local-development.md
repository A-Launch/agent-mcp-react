# Local development

How to run this repository on one machine: the port block, the mock agent runtime that stands in for a
real agent, how to drive a tool call from a shell, the environment variables the examples and the mock
agent read, the capability profiles the example dashboard offers, the test layers, and the health gate
that runs after any change.

Everything the library does end to end can be exercised without a real agent runtime, because
`tools/mock-agent/` is one: it mints connection tickets, gates the socket upgrade on them, holds one MCP
client per connected page, and runs a chat loop over the page's own tools.

## Ports

Every local process lives in the `:450xx` block so it collides with nothing else on the machine.

| Port | Component | Command |
|------|-----------|---------|
| `45000` | Mock agent runtime — MCP client, WebSocket gateway, dev ticket minter, chat agent | `pnpm dev:agent` |
| `45010` | Example application — customer dashboard | `pnpm dev:example` |
| `45020` | Example application — agent chat | `pnpm dev:chat` |
| `45030` | Example application — composable board | `pnpm dev:board` |

The three example dev servers set Vite's `strictPort`, so a taken port fails the start rather than
moving the page to `:45011` while the commands above still describe `:45010`. The mock agent's port is
the one that can be moved, with `AMR_GATEWAY_PORT` (see [Environment](#environment)).

## First run

Node 22 or later (`.nvmrc` pins 22) and pnpm 11 — the repository declares `pnpm@11.8.0` in
`packageManager`, so Corepack picks it up.

```bash
pnpm install
pnpm dev:agent      # terminal 1 — gateway on :45000; prints the ticket endpoint and the model
pnpm dev:example    # terminal 2 — customer dashboard on :45010
pnpm dev:chat       # terminal 3 — agent chat on :45020
pnpm dev:board      # terminal 4 — composable board on :45030
open http://localhost:45010
open http://localhost:45020
open http://localhost:45030
```

`pnpm dev:agent` prints, at startup, the WebSocket URL, the ticket endpoint, the health endpoint, the
control endpoints and which model the chat agent reasons with — or `model none` and the reason, when
no key is configured. That line at startup is deliberate: "the chat does not answer" is the most
expensive way to learn that a key is missing.

The page connects **outbound** to `:45000`. The browser is the MCP **server** and the mock agent is
the **client** — browser JavaScript cannot listen for inbound connections, so the server dials the
client. Why that direction is the right one is explained in
[explanation-second-control-interface.md](explanation-second-control-interface.md#the-browser-is-the-mcp-server-and-it-dials-out).

Signs it worked, in the order they appear in the `pnpm dev:agent` log:

1. `connected   tabId=…` — the gateway accepted the socket and read the page's identity.
2. `mcp ready   tabId=…` — the page answered `initialize`.
3. `pnpm -C tools/mock-agent tools` returns the tools of the mounted route.

**Having more than one page open at once is the normal posture for an end-to-end run, not an
accident.** `tests/e2e/composable-board.spec.ts` asserts that a page addresses itself when more than
one is connected; with only one tab up the mock agent answers an unaddressed control request happily,
so that case would pass while proving nothing.

### Giving the chat agent a model

To let the chat agent reason, give the **agent** process a key — the browser never sees one. Either on
the command line, or in a gitignored env file at the repository root:

```bash
ANTHROPIC_API_KEY=hunter2-secret pnpm dev:agent  # one session — your real key goes here
echo ANTHROPIC_API_KEY=hunter2-secret >> dev.env     # every session
```

`pnpm dev:agent` starts Node with `--env-file-if-exists=../../.env --env-file-if-exists=../../dev.env`,
so both `.env` and `dev.env` at the repository root are read, in that order, and a later file overrides
an earlier one. Two accepted names is a small looseness bought deliberately: `.env` is the ecosystem
convention that `.env.example` already implies, and `dev.env` is what an operator here actually
reaches for. It is `--env-file-if-exists` rather than `--env-file` because the second refuses to start
when the file is absent, and a stack that will not boot without a credential it does not need is worse
than the gap it closes.

`.gitignore` covers `*.env` as well as `.env` and `.env.*`, with only the `.env.example` templates
excepted. The dotted spellings alone would leave a file named `dev.env` fully tracked — the one
env-file mistake that stays invisible until the key is already pushed.

Without a key the stack still works end to end: the agent process says so at startup and on
`GET /agent`, the chat page shows "No model is configured" with the reason, and the chat page's tool
console calls the page's tools directly with you as the planner. There is deliberately no offline
keyword planner behind that banner — a matcher pretending to be a model would make the demonstration
claim something untrue about what chose the tool call.

## The mock agent runtime

`tools/mock-agent/` is three things in one process, deliberately.

**A ticket minter.** `GET /ticket` returns a single-use ticket that expires 30 seconds after minting,
together with the complete WebSocket URL to dial. It stands in for the application backend that a real
deployment owns and this repository does not ship; the seam it sits behind — the provider's `getUrl()`,
which returns a URL and never a credential — is the real one, so replacing it with a production service
is a change of process, not of interface. How to build the real one is in
[connecting-to-an-agent.md](connecting-to-an-agent.md#minting-a-credential-from-your-backend).

**A WebSocket gateway** on `:45000` that redeems the ticket and accepts the socket. Refusal happens at
the HTTP **upgrade**, before the handshake completes, so a rejected page never sees an `open` event
and never sends anything to an unauthenticated peer. Every refusal is `401` with the cause in an
`x-amr-refusal` header — `absent`, `unknown`, `spent` or `expired` — and is logged as
`refused     ticket <cause>`. The status is the same for all four on purpose: which tickets exist is
something the log may say and a status code a caller could probe may not.

It enforces single use. Do not relax that to make reconnection easier locally: a permissive dev gateway
accepts a replayed ticket, every local reconnection works, and the first deployment against a real
gateway fails on the second connection. The cheap environment is the one that must be strict.

**An MCP client per connected page**, and a small HTTP control surface that the CLI drives:

| Endpoint | Answers |
|---|---|
| `GET /ticket` | `{ ticket, wsUrl, expiresAt }` — a single-use ticket and the URL to dial |
| `GET /health` | `{ ok, connections }` — liveness and the connection count |
| `GET /tabs` | every connected tab and its state |
| `GET /tools?tab=` | the page's current `tools/list` |
| `POST /call` | `{ name, arguments, tab? }` — invokes one tool |
| `GET /agent` | whether a model is configured, which one, and the connected tabs |
| `POST /chat` | `{ session, message, tab? }` — one conversational turn, streamed back as server-sent events |
| `POST /chat/reset` | `{ session }` — forgets one conversation; the page keeps whatever the agent already changed |

A tab is `connecting` until the page answers `initialize`, then `ready`. A page that opens the socket
and serves no MCP is reported as `unavailable` with its cause (`mcp absent  tabId=… — <reason>`) and
then drops, because the SDK closes the transport when the handshake fails — the log line is the
diagnosis, not the tab list.

**Naming a tab is required when more than one is connected.** The gateway refuses with `400` rather
than picking one: a policy that silently chose would make a two-tab session succeed against an
arbitrary tab. Ambiguity is refused in the other direction too: two connected pages claiming the same `tabId`
both stay connected, and a control request that names that id is refused with `400` and told to give
each page a distinct identity, because a tab id is metadata the page chose for itself and nothing
makes it unique. `409` is what an empty gateway answers — no browser connected at all. The library mints one per page instance; see
[connecting-to-an-agent.md](connecting-to-an-agent.md#multiple-tabs).

`POST /chat` runs the loop that makes this an agent rather than a remote control: it reads the page's
tool list, hands those tools to the model as the only actions available, runs what the model calls
against the live connection, and feeds the results back until the model stops calling. Each turn emits
a `thinking · N tools available` line, and the log closes the turn with
`chat done   tools/list requests this turn: N`.

**It re-lists only when the page says the set changed.** The page sends
`notifications/tools/list_changed`, and that handler is the only thing that marks the cached listing
stale — no timer, no per-turn refresh. So N in the `chat done` line is the number of `tools/list` requests
the turn actually made — not one per model round trip, and often zero, because the cached listing
persists across turns and is re-read only after a change marked it stale — and `tools changed tabId=…`
appears on every real change.

MCP tool names are translated for the model and back before dispatch: the Messages API accepts
`^[a-zA-Z0-9_-]{1,64}$`, so `customers.set_filters` goes out as `customers__set_filters`. Two page tools
that would collide under that translation are refused loudly rather than dispatched as each other.

## Driving a call by hand

The CLI talks to the **running** `pnpm dev:agent` process over the control endpoints above. It never
opens its own connection: the MCP client lives in that process because it acts on a socket that process
is holding, and a second client would be a different agent looking at a different page state.

```bash
# which tabs are connected, and whether MCP answered on each
pnpm -C tools/mock-agent tabs

# what the page currently exposes
pnpm -C tools/mock-agent tools

# call a tool
pnpm -C tools/mock-agent call customers.set_filters '{"health":["at_risk"]}'

# a specific tab, when more than one is connected
pnpm -C tools/mock-agent tools <tabId>
pnpm -C tools/mock-agent call customers.set_filters '{"health":["at_risk"]}' <tabId>
```

The CLI prints the gateway's JSON response and exits non-zero on any non-2xx response. That is an
HTTP failure — an unknown tab, an unreadable body. A tool call the page **refused** is an MCP result,
delivered under `200` with `isError: true` in the body, so a script that scripts refusals reads the
body rather than the exit code. When nothing is listening it says so — `could not reach the mock agent at http://127.0.0.1:45000
— is pnpm dev:agent running?` — rather than printing a stack trace. `AMR_GATEWAY_PORT` moves the port
it talks to.

**The listing verb is `tools`, not `list`.** `pnpm list` is a built-in that pnpm runs *instead of* a
script of the same name: it prints the dependency tree and exits 0, looking exactly like the script
worked. `tests/unit/package-surface.spec.ts` asserts that no script in the mock agent collides with a
pnpm built-in, because the failure is silent.

There is no `watch` command. Following the tool set as it changes is done by reading the
`pnpm dev:agent` log, where `tools changed tabId=…` appears on every real change.

The raw endpoints work from `curl` too:

```bash
curl http://localhost:45000/health
curl http://localhost:45000/ticket
curl -X POST http://localhost:45000/call \
  -H 'content-type: application/json' \
  -d '{"name":"customers.set_filters","arguments":{"health":["at_risk"]}}'
```

## Environment

`.env.example` at the repository root holds key names and shared-dev values only; per-developer
secrets stay blank. Where a value has to go depends on who reads it. The **mock agent's** `pnpm
dev:agent` loads `.env` and then `dev.env` from the repository root (both gitignored) through Node's
env-file flags. The **examples** are served by Vite from their own directories and read neither root
file: give the dashboard its variables on the shell (`AMR_CAPABILITIES=inspect pnpm dev:example`) or
in a `.env` inside `examples/customer-dashboard/`. The **CLI** reads the shell only.

| Variable | Read by | Meaning |
|----------|---------|---------|
| `AMR_CAPABILITIES` | customer dashboard | Which capability profile the page grants: `none`, `standard`, `inspect`, `developer` or `evaluate`. Absent means `standard`. **An unrecognised value throws while the module is evaluated, before React runs, and the page does not mount.** See [Capability profiles](#capability-profiles). |
| `AMR_INSPECTOR` | customer dashboard | `0` turns OFF the in-page inspector and `window.__AGENT_MCP__`. **On by default in this example**, because inspecting it is the point; the provider's own default is off, and the channel also needs a development build. See [observing-tool-calls.md](observing-tool-calls.md#the-inspector). |
| `AMR_GATEWAY_PORT` | mock agent (server and CLI) | The gateway's port. Defaults to `45000`. The server parses it with `Number.parseInt`: a value with no leading integer refuses to start rather than falling back; a trailing suffix is dropped silently. The CLI passes the value through as given. |
| `ANTHROPIC_API_KEY` | mock agent | The chat agent's model credential. Absent means no chat, stated plainly at startup and on `GET /agent`. Never reaches a browser. |
| `AMR_MODEL` | mock agent | Which model the chat agent reasons with. Defaults to `claude-sonnet-5`. |
| `ANTHROPIC_BASE_URL` | mock agent | Where the Messages API is. Defaults to Anthropic's endpoint; point it elsewhere to exercise the model path without a key (below). |

The dashboard's and the board's `AMR_` variables reach the browser only because those two examples'
`vite.config.ts` set `envPrefix: 'AMR_'`; the chat example reads no `AMR_` variable and sets no prefix. Vite's default prefix is `VITE_`; without that line every `AMR_` variable reads as
`undefined` at runtime — a knob that looks like configuration and changes nothing.

`.env.example` also names `AMR_AGENT_WS_URL` and `AMR_TICKET_URL`. As of this writing **no example
reads them**: the dashboard and the board dial `http://localhost:45000` from a constant
(`AGENT_ORIGIN` in each example's `src/`), fetch `/ticket` from it, and dial the `wsUrl` the ticket
response carries. Change the constant, not the variable.

### Exercising the model path without a key

Point the agent at any server that speaks the Messages contract:

```bash
ANTHROPIC_API_KEY=hunter2-secret ANTHROPIC_BASE_URL=http://127.0.0.1:8787 pnpm dev:agent   # any ASCII value; the stand-in never reads it
```

Everything except the model's judgment is then real — the request body, the tool payload, the loop,
the SSE stream, the socket and the page. `tests/unit/mock-agent/model.spec.ts` pins the same request
contract without a server at all. What neither can prove is that the live API **accepts** the schemas;
that needs a run against a real key.

## Capability profiles

`AMR_CAPABILITIES` selects what the customer dashboard grants an agent. It is read by
`examples/customer-dashboard/src/capability-profile.ts`, which maps each name onto the provider's
`capabilities` prop. The names and the three levels they grant are explained in
[reference-capabilities.md](reference-capabilities.md#the-three-levels).

| Profile | `application` | `dom.inspect` | `dom.interact` | `evaluate` |
|---|---|---|---|---|
| `none` | no | no | no | no |
| `standard` (default) | yes | no | no | no |
| `inspect` | yes | yes | no | no |
| `developer` | yes | yes | yes | no |
| `evaluate` | yes | yes | yes | yes |

```bash
AMR_CAPABILITIES=none pnpm dev:example        # grants nothing — every agent call refused
AMR_CAPABILITIES=standard pnpm dev:example    # Level 1 only, the default
AMR_CAPABILITIES=inspect pnpm dev:example     # Level 1 plus READING the page: dom.snapshot, dom.get_text
AMR_CAPABILITIES=developer pnpm dev:example   # Level 1 plus both halves of the DOM capability
AMR_CAPABILITIES=evaluate pnpm dev:example    # everything, including runtime.evaluate
```

**`none` is the one worth running**, because it is the only way to watch a capability refusal in a
real browser. With it set, the inspector shows the same tool decided two ways:

```
#1 customers.set_filters · bridge · refused at capability — MCP_TOOL_CAPABILITY_DENIED
#2 customers.set_filters · registry 3 ms · ok        ← the SAME tool, called by a page script
```

That pairing is the rule a capability governs this library's bridge and not the page, made visible.
The tools stay in the document's registry and stay callable by anything running in it, and the page
keeps working — the screen still updates, because the application's own code is not the agent. Why
that is the right boundary is in
[explanation-reachability.md](explanation-reachability.md).

**`inspect` is the profile to reach for when an agent must cope with an uninstrumented flow.** The
agent can describe the page and cannot act on its DOM — the application's own Level 1 tools stay
callable, since the profile grants `application` — which is what makes the two halves of the DOM
capability visibly different. `developer` adds acting on the page; both are documented in
[dom-inspection.md](dom-inspection.md).

**`evaluate` is a separate profile rather than part of `developer`**, because bundling arbitrary code
execution into "the developer preset" is how it ends up somewhere nobody meant it to be. It exists so
an operator can watch the gate work — the refusal under every other profile and the confirmation a
person answers under this one — and for no other reason. It is never the default of anything, never a
profile an embedder copies without reading [javascript-evaluation.md](javascript-evaluation.md), and
never enabled to unblock a task.

**A mistyped profile refuses to start.** `AMR_CAPABILITIES=stanadrd` throws while the module that
selects the profile is evaluated — before React mounts, so no error boundary sees it — the page does
not mount, and nothing is exposed — no registry claim, no socket, no tab at the gateway. A typo
that silently became `standard` would hand an agent capabilities an operator believed they had
withheld, and would look exactly like a working deployment. An **absent** value is different from a
wrong one: nothing was chosen, so the documented default applies.

The dashboard's dev server also serves the page under a real Content-Security-Policy that omits
`unsafe-eval` when the URL carries `?csp=strict`. That is how `runtime.evaluate`'s behaviour under a
strict policy is measured, because a CSP cannot be faked from the test side; see
[javascript-evaluation.md](javascript-evaluation.md#when-your-page-forbids-it).

## The test layers

Five layers, each with a job nothing else can do. Four are Vitest projects in `vitest.config.ts`;
end-to-end is Playwright, because it needs a real browser and that is the whole point of it. A layer's
include pattern never overlaps another's: a spec picked up by two projects would run twice under two
environments, and the version that passes would hide the one that does not.

| Command | Layer | What it covers | What must be running |
|---|---|---|---|
| `pnpm test` | `unit` + `react` | Registry, validation, policy, serialization, reconnection schedule, the built artifact, conformance of adopted packages; and React Testing Library cases for mount, rerender, unmount, StrictMode and route change | Nothing |
| `pnpm test:transport` | `transport` | Framing, invalid JSON, closure, reconnect, auth rejection, concurrent calls, cancellation — against a **real local WebSocket server**, never a mocked socket | Nothing — the suite starts the mock agent's gateway in-process on an ephemeral port |
| `pnpm test:integration` | `integration` | The example application driven by the mock agent through the whole stack: real provider, real transport, real store. Asserts the rendered consequence and its **agreement** with what the tool reported | Nothing — same in-process gateway |
| `pnpm test:e2e` | Playwright, three engines | What only a browser can catch: bundling, the SSR boundary, `crypto.randomUUID` availability, real socket closure semantics, page-level redaction, the multi-tab addressing case, `runtime.evaluate` under a strict CSP | `pnpm dev:agent`, `pnpm dev:example` **and** `pnpm dev:board` — the run starts nothing, so a broken start command fails it rather than hiding inside it. The strict-CSP evaluation case runs only when the run is invoked with `AMR_CAPABILITIES_PROFILE=evaluate`; otherwise it is skipped, and the skip says so. It also needs the dashboard served with `AMR_CAPABILITIES=evaluate` — that is a prerequisite the case does not check, so set the runner variable without it and the case runs and fails waiting for a confirmation |
| `pnpm test:e2e:native` | Playwright, opt-in | Chromium launched with `--enable-features=WebMCP`, so the page runs against the browser's **own** tool registry rather than the portability shim. Findings are transcribed into [conformance.md](conformance.md) | Nothing beyond Chromium — the lane serves its own page |

Where each layer's cases live:

- `tests/unit/` and `src/**/*.spec.ts` — Node by default, with named exceptions: a case declares
  jsdom in its own docblock where the unit under test is the document boundary or a DOM tool, and the
  SSR-boundary case renders the provider in Node because that IS the claim. `tests/conformance/` runs in this
  project too: its cases pin the behaviour of adopted packages and need neither a server nor a browser.
- `tests/react/` — mount → tool exists; rerender → no re-registration; handler sees current state;
  unmount → tool gone; StrictMode → nothing leaked; route change → tool set changes. Read from the
  shared registry and the provider's reports; the transport and integration layers are where the same
  facts are asserted through an MCP client.
- `tests/transport/` — imports the gateway from `agent-mcp-mock-agent`, the same one `pnpm dev:agent`
  runs, so the suite tests the gateway a developer actually connects to.
- `tests/integration/` — the acceptance scenario as ordered cases over **one** application that is
  built once and advanced, so a failure cascades and the first red names where the narrative broke.
- `tests/e2e/` — one suite run on Chromium, Firefox and WebKit. Firefox and WebKit take the
  portability shim for the tool registry, and that path carries the same test obligation as any other,
  so they run the same cases rather than a reduced set. What three engines do and do not evidence is
  recorded in [browser-support.md](browser-support.md).

The end-to-end suite reads four overrides for where the servers are, all defaulting to the port block:
`AMR_EXAMPLE_URL` (`http://localhost:45010`, also Playwright's `baseURL`), `AMR_BOARD_URL`
(`http://localhost:45030`), and — for the mock agent's HTTP surface — `AMR_AGENT_URL` in the
composable-board cases and `AMR_AGENT_HTTP` in the CSP case (both `http://localhost:45000`). The
native lane is admitted by `AMR_NATIVE_REGISTRY`, which the `test:e2e:native` script sets; the project
is absent from a default run rather than present-and-skipped, so a skipped lane cannot be mistaken for
evidence that something ran.

## The health gate

After any change under `src/`, `examples/` or `tools/`:

```bash
pnpm gate
```

One command, fail-fast, and `package.json` is the only place its list is spelled — read it there
rather than from a copy that can drift.

What each is there for:

- `pnpm build` — clears its own state and compiles with `tsconfig.build.json`. It is in the gate
  because it had been broken for a long stretch of the project's history: exiting non-zero while
  emitting unloadable JavaScript, and emitting nothing at all while exiting zero on an incremental run
  over a stale `.tsbuildinfo`. `tests/unit/built-artifact.spec.ts` asserts what is **in** the output
  rather than what the command returned.
- `pnpm build:examples` — each example application's own production build. An example that stops
  building is an embedder's usage that stopped compiling, which is what these applications exist
  to demonstrate.
- `pnpm test`, `pnpm test:transport`, `pnpm test:integration` — the layers above.
- `pnpm typecheck` — `tsc --noEmit` for the library and for each of the three examples.
- `pnpm lint` — `biome check .`; `pnpm lint:fix` applies what it can.
- `pnpm verify:package` — packs the tarball **with pnpm** (the only packer that applies this
  package's `publishConfig`), reads the tarball's own manifest, and asserts that every target its
  `exports` map declares is present inside the tarball. Needs no network, and needs `pnpm build` to
  have run first. It exists because a tarball once resolved none of its exports while every other
  check was green.
- `pnpm verify:consumer` — packs the library, installs it into a project **outside this repository**,
  typechecks against the shipped types and bundles with a real bundler. It exists because the README's own minimal example did not compile, and nothing in-repo could see it:
  in-repo code resolves the library through workspace paths and a root tsconfig that differs from a
  consumer's. See [consuming-without-publishing.md](consuming-without-publishing.md).

Three more run separately, because they need dev servers or browser binaries, and a gate with setup is
a gate that gets skipped:

```bash
pnpm test:e2e               # three engines, real browser, real socket — needs the three dev servers
pnpm test:e2e:native        # opt-in: Chromium with its native tool registry enabled
pnpm verify:consumer:runs   # serves the external consumer's production bundle and asserts it MOUNTS
```

`verify:consumer:runs` is the step after `verify:consumer`: a bundle that compiles can still throw on
import, fail to install the registry, or register nothing. It checks all three declaration paths —
`useMcpTool`, `useMcpState` and a module-scope `registerMcpTool` — and fails loud rather than skipping
when no browser is installed.

**Break-it-to-prove-it.** After adding or changing a capability gate, a policy branch, a redaction
rule or a lifecycle guarantee: delete the check, watch its case go red, restore it, and record that in
the pull request. A suite that stays green without the check was never testing it.

## When a connection drops

The page recovers on its own. Stop `pnpm dev:agent` with a page connected and the provider's status
shows `reconnecting`, with the attempt number climbing on the schedule in `src/transport/reconnect.ts`:
500 ms, 1 s, 2 s, 4 s, 8 s, 15 s, then 30 s held. Start it again and the page reconnects with no
reload, takes a **fresh** ticket, and the agent is re-told the current tool set — a recovered
connection is a new MCP session, so its first listing is whatever is mounted at that moment. The state
machine and the schedule are documented in
[connection-lifecycle.md](connection-lifecycle.md#the-backoff-schedule).

Two things worth watching in the `pnpm dev:agent` log:

- **`connected   tabId=…` with the same id as before the drop.** A page identity belongs to the page
  instance, not the connection, so a recovery keeps it.
- **No `refused` lines.** Every attempt mints its own ticket, so `spent` or `expired` after a restart
  means something is reusing one — which is the failure that only shows up against a real gateway.

**A first attempt that fails does not retry.** If the page has never connected — a wrong URL, a gateway
that was never up — it reports `error` once and stops; there is no edge from `error` to anything but
teardown. Retrying forever would hide a misconfiguration behind a spinner. So "it says error and never
retries" on first load means check the URL, not the reconnection.

## When nothing connects

In this order — roughly cheapest first, and each step rules out a whole class:

1. **Is the gateway up?** `curl http://localhost:45000/health` should answer `{"ok":true,...}` and
   `curl http://localhost:45000/ticket` should return a ticket.
2. **Did the page get a ticket?** A failed fetch surfaces as `MCP_WS_URL_UNAVAILABLE`, which is a
   different cause from a failed dial and points at a different process — the backend that mints, not
   the gateway.
3. **Was the ticket spent?** Tickets are single-use, and a page that reloaded and reused one gets
   `MCP_WS_CONNECTION_FAILED` — the same code a dead gateway produces, because the two are
   indistinguishable to a page. There is no `MCP_WS_AUTH_FAILED`; nothing in the library produces one,
   and a page that guessed would be wrong every time the gateway was merely down. So this step is ruled
   out from the **agent's** log — which does distinguish `absent`, `unknown`, `spent` and `expired` —
   rather than from anything the page reports. Why the page cannot know more is in
   [connecting-to-an-agent.md](connecting-to-an-agent.md#what-a-refused-page-can-and-cannot-tell-you).
4. **Is it a secure-context problem?** `crypto.randomUUID` is unavailable over plain HTTP from a
   non-localhost address — the usual cause when it works on the laptop and fails on a phone. The page
   fails loudly here with `MCP_PAGE_IDENTITY_NO_UNIQUE_SOURCE` rather than dialling with an identity it
   could not mint.
5. **Is the page addressed?** With two tabs connected, every unaddressed control request is refused
   with `several tabs are connected; name one with ?tab=`. Pass the tab id, or close the other page.

The error codes themselves are in [reference-error-vocabulary.md](reference-error-vocabulary.md).

## See also

- [README.md](README.md) — the documentation index
- [connecting-to-an-agent.md](connecting-to-an-agent.md) — the gateway a real deployment runs
- [reference-capabilities.md](reference-capabilities.md) — the capability shape and the gate chain
- [observing-tool-calls.md](observing-tool-calls.md) — the callbacks and the in-page inspector
