# Store adapters

Thin bindings from one store action to one tool. Optional and deletable: removing one removes a
convenience, never a capability.

```ts
import { bindReduxTool } from '@agent-mcp/react/redux';

bindReduxTool({
  name: 'customers.set_filters',
  description: 'Narrows the customer list.',
  inputSchema: CustomerFiltersSchema,
  dispatch: store.dispatch,
  action: (input) => customerActions.setFilters(input),
  selectResult: () => store.getState().customers.filters,
});
```

```ts
import { bindZustandTool } from '@agent-mcp/react/zustand';

bindZustandTool({
  name: 'customers.set_filters',
  description: 'Narrows the customer list.',
  inputSchema: CustomerFiltersSchema,
  action: (input) => useCustomerStore.getState().setFilters(input),
  selectResult: () => useCustomerStore.getState().filters,
});
```

```ts
import { bindNavigationTool, bindUrlFilterTool } from '@agent-mcp/react/router';

bindNavigationTool({
  name: 'customers.open',
  description: 'Opens one customer.',
  inputSchema: { type: 'object', properties: { customerId: { type: 'string' } }, required: ['customerId'] },
  navigate,
  toPath: (input) => `/customers/${input.customerId}`,
});
```

## You do not need an adapter

The design's own primary example of a Redux-backed tool is `useMcpTool` with a dispatch inside the
handler, and **that works today with nothing imported from here**. An adapter is for a tool the
application *shell* owns rather than a screen, and for the two things it adds:

1. **The call resolves only after your application accepted the mutation.** A dispatch is synchronous
   and a React render is not. A handler that dispatched and returned would report success while the
   screen still showed the old value — which is this system's characteristic defect. Adapters await
   the commit before reporting anything.
2. **It reports what the call applied**, through a selector you wrote.

Everything else is `registerMcpTool`, which they are built on. See
[Declaring tools outside React](tools-outside-react.md).

## One action, never a store

Every adapter binds **one** action, chosen once, by you, at declaration. None of them accepts a store.

That is the whole design, and the reason is the rule that a tool expresses intent, never an
implementation operation (see [Intent, not implementation](design.md#intent-not-implementation)):
a generic mutation tool — `redux.dispatch`, `zustand.set`, `react.set_state` — widens the reachable
state space past every schema you declared.
Handing an adapter a store would let an agent reach every action that store has ever had, under one
schema that cannot describe them.

**For Redux this is enforced by the type**: a store is not an action creator, so passing one is a
compile error.

**For Zustand it cannot be.** A bound action and `store.setState` have the same structural type —
both take an object — so no signature can tell them apart. This is stated rather than hidden because
the guarantee is genuinely weaker here:

```ts
// Fine: one action, and the schema says what it takes.
action: (input) => useCustomerStore.getState().setFilters(input)

// `zustand.set` with extra steps. Nothing in the types objects.
action: useCustomerStore.setState
```

What bounds it either way is **the schema you declare**. Arguments are validated in the runtime before
the action runs, so a real schema narrows what any action can be given — and
`additionalProperties: true` over an open object is a generic mutation tool whatever the adapter's
types say.

## `selectResult` reports an outcome. It is not a state surface.

It says what *this call* applied. Exposing state for an agent to read is
[`useMcpState`](exposing-state.md), which requires a schema and names its getter as the disclosure
boundary.

The distinction matters because the leak is the same one:

```ts
// WRONG, exactly as it is wrong in useMcpState.
selectResult: () => store.getState()

// RIGHT: what this call changed.
selectResult: () => store.getState().customers.filters
```

Whatever the selector returns crosses to the agent unchanged. The library traverses nothing and
redacts nothing.

## Navigation is Level 1

There is **no navigation capability**. The capability members are `application`, `dom` and
`evaluate`; navigation is an ordinary application action.

The observation that suggests one is true and worth knowing: **navigating changes which tools
exist**, because a route change unmounts the components that declared them. An agent that navigates
may find the tool it was about to call has gone. That is a reason to prefer a domain intent —
`customers.open` taking an id — over a generic `navigation.go` taking a path. It is not a reason for a
separate capability: it is a riskier action, not a different kind of authority.

That is not an inference. In `examples/customer-dashboard`, moving from the customers screen to the
activity screen takes the agent's listing from eleven tools to one. The eleven are the ten the
customers screen's components declare plus the module-scope `shell.go_to`, counted with no account
drawer open and nothing above Level 1 granted; opening the drawer or granting a DOM capability adds
more. The one that remains is `shell.go_to`, because the shell owns it and the shell did not unmount.
Calling a tool that left with its screen is **refused**, not merely absent.

### The `navigate` you pass must exist outside React

`bindNavigationTool` is usually declared at module scope, and a router's `useNavigate` is a hook —
unreachable from there. The workaround people reach for is a mutable ref that a component fills in an
effect, and a tool built on one is **registered and non-functional until something renders**: it is in
`tools/list`, an agent may call it, and it does nothing. A tool that lies about being ready is worse
than one that is not there.

Pass a navigate that already exists instead. A **data router** gives you one — `router.navigate` is a
method on an object created before React mounts:

```ts
export const router = createBrowserRouter(ROUTES);   // module scope

bindNavigationTool({
  name: 'shell.go_to',
  inputSchema: { type: 'object', properties: { screen: { type: 'string', enum: ['customers', 'activity'] } }, required: ['screen'] },
  toPath: (input) => (input.screen === 'activity' ? '/activity' : '/'),
  navigate: (path) => router.navigate(path),
  selectResult: () => ({ screen: router.state.location.pathname }),
});
```

Note what crosses from the agent: a member of a closed vocabulary, not a path. `toPath` BUILDS the
path here. The design prefers a domain intent over a path and shows both; this example goes further
and restricts navigation to a closed vocabulary, because a tool
that accepted a path would let an agent reach every route the router accepts —
a wider surface than the tool's description claims, and the enum is what an agent reads to choose.

To withhold a particular route, declare it unavailable:

```ts
permissions: { available: user.canViewBilling }
```

## `useMcpAction` does not ship

The original design sketched a convenience wrapper:

```ts
useMcpAction('customers.clear_filters', { description: '...', handler: clearFilters });
```

It is not here, deliberately. Compare it with what it would wrap:

```ts
useMcpTool({ name: 'customers.clear_filters', description: '...', handler: clearFilters });
```

The ceremony it removes is one object key. A second way to spell one thing is a second thing to
document, to keep consistent, and to get subtly wrong — so `useMcpTool` is the one spelling for
declaring a tool in a component, and `registerMcpTool` is the one for declaring it outside.

## Related

- [Declaring tools outside React](tools-outside-react.md) — what adapters are built on
- [Declaring a tool](declaring-a-tool.md) · [Exposing state](exposing-state.md)
