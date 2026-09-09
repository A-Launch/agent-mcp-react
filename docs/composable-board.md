# The composable board

A second demonstrator, on `:45030`, whose **screen layout is the shared surface**. A person types "show
me a table of accounts and a tile with total revenue" into the chat on the left; panels appear on the
right; and the same panels can then be added, configured, reordered and removed with the mouse.

```bash
pnpm dev:agent      # :45000  the mock agent runtime
pnpm dev:board      # :45030  this page
```

## What it is not

"Dynamic UI from chat" reads as an invitation to hand the agent a rendering primitive. It is not one
here, and refusing that is the whole point of the demonstration.

The application owns a **closed, build-time catalog of seven panel kinds**, and the agent instantiates
from it through the same functions the toolbar calls. Nothing the agent sends is rendered — not markup,
not a component description, not a layout tree, not an expression. Remote React rendering is a named
non-goal (see [Non-goals](design.md#non-goals)), and a generic mutation tool is a forbidden pattern; a
panel-shaped blob argument would have been both.

The catalog lives in [`catalog/kinds.ts`](../examples/composable-board/src/catalog/kinds.ts). There is no
registry to add to at run time and no name lookup that falls through to a generic renderer.

## The catalog

| Kind | Bound sources | Its own actions |
|---|---|---|
| `table` | `accounts`, `revenue_by_region`, `deals`, `activity` | `set_sort`, `set_filter` |
| `metric` | `accounts`, `revenue_by_region`, `signups_by_month`, `sites`, `deals` | `set_measure` |
| `chart` | `revenue_by_region`, `signups_by_month` | `set_shape` |
| `form` | `accounts` | `fill`, `submit` |
| `map` | `sites`, `revenue_by_region` | `set_focus`, `set_measure` |
| `timeline` | `activity` | `set_window`, `set_kinds` |
| `pipeline` | `deals` | `focus_stage`, `advance_deal` |

A **kind/source pair** is validated, never each half independently: `chart` and `accounts` are both
individually legal and the combination is not, and neither is `map` and `accounts` — an account row
carries no position.

The three richer kinds each carry something the first four do not:

- **`map`** draws real geography on an equirectangular projection as hand-written SVG — no tile layer,
  no mapping library, no network. The coastlines and borders are **Natural Earth 1:110m** (public
  domain), decoded once from world-atlas' TopoJSON into `src/data/generated/world.ts` by
  `scripts/build-world-map.mjs`, so the panel draws the same map on a plane as on a desk. Arcs are stored
  apart from the rings because TopoJSON shares them: the border between two countries is one polyline
  held once rather than two drawn over each other. **A focus is a MEMBER of a closed set** (`world` plus
  five named regions), never a bounding box: "show me EMEA" stays an intent instead of four numbers an
  agent can get subtly wrong. `sites` carries `lat` and `lon` as ordinary numeric columns;
  `revenue_by_region` does not, and the renderer holds one centroid per named region — a build-time fact
  about five regions, not a geocoder.

  Two things about drawing a whole world only a screenshot could have caught, both now written into the
  code: a ring that steps from +179° to −179° draws a line straight across the map unless its longitudes
  are unwrapped, and splitting such a ring instead is worse, because SVG closes a polygon from its last
  point back to its first and the seam runs from Siberia to the South Pacific. Land and sea also needed
  tokens of their own — the first version painted them in two greys four hex digits apart, and nobody
  could see the continents.
- **`timeline`** takes an **array** argument (`set_kinds`) and an **integer with a declared range**
  (`set_window`, 1–365). Both are enforced by the runtime before the handler, so the application never
  sees a window of −4 days or a list with an unknown member in it. An empty list is how a filter is
  cleared — one spelling for "no filter", rather than a missing argument meaning something.
- **`pipeline`** is the one panel that **changes data rather than the way it is displayed**.
  `advance_deal` is confirmation-required and moves a deal to the next stage; `focus_stage` is not,
  because looking at something is not doing something and asking a person to approve a filter trains them
  to click through the prompt that matters. The stage order lives in `ADVANCING_STAGES` and nowhere else,
  so a stage inserted there changes what advancing means everywhere at once.

## The tools

Three composition tools, declared by the application **shell at module scope** through
`agent-mcp-react/actions` — their owner is the document, not a screen, so they exist before React
mounts:

- `board.add_panel` — takes a **list** of `{ kind, source }`, so one request is one call and either all
  the panels appear or none does. It accepts **no settings**; panels start at their kind's defaults. It
  reports the actions each new panel declares, so the agent learns what it gained without re-listing.
- `board.remove_panel`, `board.reorder`
- `board.get_state`, published by `useMcpState` from the board component rather than by the shell

Plus, from each mounted panel, its own actions named `panel.<id>.<verb>`.

**The identifier is part of the NAME and never an argument.** A panel's action exists only while its
panel does, so addressing a panel that has been removed is `MCP_TOOL_NOT_FOUND` — a tool that is not
there — rather than an argument that fails validation.

## Seven things that will bite you

Each of these is quiet. None is caught by a type. Every one has a case, and four have a
break-it-to-prove-it recorded against them.

1. **A position-derived panel id.** Ids come from one monotonic counter and never from an index; an
   index-derived id renames every tool below a moved panel on every reorder.
2. **A position-derived React key.** The other half, and it survives a correct id: with an index key
   React reuses one component instance for a different panel across a reorder and renames its actions
   underneath it. A listing comparison cannot catch it — swapping two panels of the same kind leaves a
   position-derived name list byte-identical while every tool now drives the wrong panel. The reorder
   case asserts **identity continuity**, not bytes.
3. **A descriptor that moves with a setting.** Every panel's name, title, description and schemas depend
   only on its immutable id, kind and source. A descriptor that read `settings` would make each sort a
   withdraw-and-register cycle: a tool-list-change storm and a window in which the tool does not exist.
4. **A half-wired confirmation surface.** The surface hands back `dialog` AND `resolver`, and both are
   needed. With only the dialog wired every call is refused `MCP_TOOL_CONFIRMATION_UNAVAILABLE` and the
   prompt never appears — a page that looks instrumented and is not. It fails *safe*, which is why only
   a live run or a case that waits for the prompt catches it.
5. **A secret field masked instead of omitted.** `board.get_state` omits a secret field's `value` key
   entirely — not `"***"`, not `null`, not `""`. A placeholder is a value the agent can read back and
   echo into a fill, and it discloses that the field is set.
6. **Forgetting the store's side-effect import.** `shell-tools.ts` is imported for its side effect by
   the entry point and by the test harness. Without it the composition tools are never declared, and the
   symptom is an empty tool list rather than an error.

7. **A stylesheet rule that matches nothing.** The confirmation dialog's rules were written for
   `.confirm-panel`, a class no component renders, so the panel that gates every agent mutation drew
   with no background and no width — its heading and the arguments a person is approving painted
   straight onto the board behind them. Every case stayed green: the test ids and the button names
   were right the whole time, and a selector that matches nothing is invisible to the compiler and the
   linter alike. It was found by watching a recording of the page, and it now has a case that asserts
   the panel PAINTS — computed background and width — rather than that it exists.

## A refusal is a RESULT, not an exception

This is the finding the demonstrator produced, and it changes how an application should be written.

A handler that **throws** has its message replaced with a generic
`MCP_TOOL_EXECUTION_ERROR: the tool "…" failed while running`. The original text is appended only in a
development build.

That suppression is **correct**. An exception can carry internals, a stack, or a value the agent was
never meant to see, and a production build must not send those to the agent (see
[Throwing loses your message](reference-error-vocabulary.md#throwing-loses-your-message)).

The consequence for an application is the part worth remembering: **guidance the agent should act on has
to be RETURNED.** "That kind does not accept that source, it accepts these" is information, not a crash.
So every domain refusal here travels as `ok: false` with a `refused` message naming what would have been
accepted, declared in the output schema and stated in the tool's description.

Two refusal routes, and they are different on purpose:

| Route | Shape | Example |
|---|---|---|
| The runtime, before the handler | `isError: true`, naming the field and the permitted set | an undeclared property; a kind outside the `enum` |
| The application, from the handler | `ok: false` with `refused` | a kind/source pair; the panel ceiling; an unknown id |

A refusal is something the application chooses to disclose, exactly as `getState` is. An exception is the
thing it must not leak.

## The chat, and how it addresses this page

The chat and the board share one page. They are two independent channels to the same local process — an
HTTP conversation and the MCP socket — and neither is built on the other. A board change is visible
whether it came from the chat, the toolbar, or an agent with no conversation at all.

`tab` and `session` go in the **JSON body** of `POST /chat`, not the query string, and both carry this
page's own `useMcpTabId()` value:

- `tab` because the runtime refuses an unaddressed control request whenever more than one page is
  connected — and the other demonstrator on `:45010` routinely is.
- `session` because it otherwise defaults to the literal `'default'`, so two chat pages silently share
  one conversation. That never errors; each page is simply told about panels that never existed on its
  own board.

This is **routing, not authorization**. The gateway redeems the connection ticket at the socket upgrade
and reads the tab id strictly afterwards, so the id never enters an admission decision. And the page does
not invent the id — the library mints one per document.

## Capabilities

Level 1 only, hardcoded:

```tsx
capabilities={{ application: true, dom: { inspect: false, interact: false }, evaluate: false }}
```

The withheld halves are the **evidence**, not a precaution: with semantic-DOM control unavailable, every
panel that appears is provably the result of a declared action rather than a synthetic click.

Withholding `dom` unregisters nothing. Level 1 tools live in the document's shared registry and any
script on the page can still invoke them — a capability governs this library's bridge, not the page
(see [A capability governs the bridge, not your page](explanation-reachability.md#a-capability-governs-the-bridge-not-your-page)).

## Tests

`pnpm test:integration` runs them beside [the acceptance scenario](design.md#the-acceptance-scenario)'s
narrative, on their own harness
(`tests/integration/board-harness.tsx`): the existing harness mounts the customer dashboard
unconditionally and cannot drive a second application.
