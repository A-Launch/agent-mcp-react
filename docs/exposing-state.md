# Exposing state for inspection

Mutation tools alone are insufficient. An agent that has just called `customers.set_filters` has no
way to ask what the filters now are, how many rows the page is showing, or whether its change landed
— it can only act and assume.

`useMcpState` is the read half of the control interface.

> **`createAjvValidator` requires CSP `unsafe-eval`.** Ajv compiles schemas into JavaScript with
> `new Function`, so under a `script-src` that omits `unsafe-eval` it throws while compiling — and a
> tool whose declared schema has no working validator is **not registered at all**, so a strict-CSP
> page exposes nothing. Supply your own `SchemaValidator` instead; see
> [the defect record](issues/validator-requires-unsafe-eval.md) and the worked example in
> `examples/customer-dashboard/src/csp-safe-validator.ts`.

```tsx
import { useMcpState } from 'agent-mcp-react';

function CustomersPage() {
  const [filters, setFilters] = useState<Filters>({ status: [] });
  const rows = useFilteredCustomers(filters);

  useMcpState({
    name: 'customers',
    description: 'The current customer list state.',
    schema: CustomerStateSchema,
    getState: () => ({
      filters,
      resultCount: rows.length,
    }),
  });

  return <CustomerTable rows={rows} />;
}
```

The agent sees one tool, **`customers.get_state`**, and calls it with no arguments. The name is
derived from the `name` you gave — you never write it yourself, and it is not configurable.

Everything a `useMcpTool` tool gets, a state surface gets: it registers after commit, it withdraws on
unmount, a rerender costs nothing, every capability and permission gate applies, and a read is
refused at invocation rather than merely hidden from the listing.

---

## The five things to know before you ship one

Each of these is a belief you would otherwise form for free, and four of them are limits rather than
features.

### 1. `getState` is the disclosure boundary. The library redacts nothing.

This library traverses no store, scans no object graph and injects no field. What reaches the agent is
**exactly what your `getState` returned** — which is what the rule that nothing is included
*automatically* (see [what the library redacts, and what it does not](reference-capabilities.md#what-the-library-redacts-and-what-it-does-not))
actually means, and it is deliberately narrower than "the library protects you".

```tsx
// WRONG. Sends the whole store — session, tokens, user records — to the agent.
useMcpState({ name: 'customers', schema, getState: () => store.getState() });

// RIGHT. You choose each field that crosses.
useMcpState({
  name: 'customers',
  schema: CustomerStateSchema,
  getState: () => ({ filters, sort, page, resultCount }),
});
```

The wrong version is shorter, reads as correct, and reviews as correct. It is named here rather than
left to inference because that is precisely why it is dangerous.

Build a value **for the agent**. Do not hand over a store, a session, a user record, or anything you
have not looked at.

### 2. The schema is a contract, not a redactor.

Declaring a schema does not bound what leaves your page. A field the schema does not mention still
crosses, because JSON Schema admits unmentioned properties and this library does not rewrite what you
wrote. A declared `token: string` crosses exactly as asked.

This is a deliberate decision, taken over the obvious alternative — synthesizing a closed schema and
failing on undeclared fields — for a reason worth knowing, because it is the reason no schema-based
mechanism can do this job:

- A closed schema **cannot express secrecy even when perfectly implemented**. A declared
  `token: string` passes. `user: { type: 'object' }` passes everything beneath it. A JWT inside a
  declared `notes: string` passes. Shape is not sensitivity.
- Rewriting your schema would mean the listing advertises one contract while the gate enforces
  another — one contract with two authorities.
- Silently dropping undeclared fields would turn "you forgot a field" into "the field is absent",
  which nobody downstream can tell apart.

So the schema does what a schema is good at: it is enforced, exactly as you wrote it, in both call
routes, and a result that violates it is refused rather than sent.

### 3. A state change sends nothing. The agent learns by calling again.

There is no push channel, and there is no `notifications/state_changed` in the protocol era this
connection negotiates. `tools/list_changed` is sent when the agent-visible **tool set** moves — a
surface appearing or disappearing — and never when a value inside one changes.

That is a consequence of the design rather than a rule the hook remembers: the change signal is driven
by the registry and the ownership record, and `getState`'s return value writes to neither. Type into a
filter box a hundred times and the agent hears nothing.

Do not design a workflow around being notified. An agent that needs current state calls the tool.

### 4. Any script on the page can read it.

`customers.get_state` is an ordinary Level 1 tool in the document's shared registry, so it is callable
by any script in the page — an analytics snippet, a browser extension's content script, another MCP
library — exactly like every other Level 1 tool you declare (see
[Declaring a tool](declaring-a-tool.md)).

Withholding the `application` capability refuses the **agent's** call and changes nothing about the
page's. If state must not be readable by page scripts, it must not be in a state surface.

### 5. A schema violation reaches the agent as a bare refusal.

When `getState` returns something the schema forbids, the agent is told only that the result does not
match the declared output schema. The validator's reason is deliberately withheld, and this is the one
refusal in the chain where that is right: an output violation is your application's defect, the agent
has nothing it can correct, and the detail is application-derived — a validator names the offending
property, and an object's keys are routinely identifiers.

**The detail does not reach an observer either**, and that is deliberate rather than an oversight: a
validator writes its reason freely and may quote the value it rejected, so the observability surface
and the inspector are given the failure code and the gate outcome and nothing more. The reason is
interpolated into the error the CALLER receives — which, for a page script calling through the shared
registry, is your own code at the call site. That is where the defect is, and where you will read it.

---

## What a read costs, and what it does not

| | |
|---|---|
| Rerender with the same declaration | Nothing. No registry operation, no notification — however many times the state moved, and however the declaration was written. |
| Change the description or the schema | One withdraw-and-register cycle, one notification. |
| State changes | Nothing. |
| Unmount | The tool is withdrawn; a later call is **refused**, not merely absent. |

The schema is compiled once at declaration, never per call.

---

## When it refuses

| Condition | What happens |
|---|---|
| `schema` omitted | Refused at declaration, immediately, in every build. A state surface's return value **is** its contract. |
| Schema declared, no validator on the provider | Refused — install `createAjvValidator` from `agent-mcp-react/validation`. |
| The derived name is already taken | The usual duplicate refusal: the later registration is rejected, the original stays callable, and it is reported without unmounting the page — development also names the source on the console. Note this can happen without you writing the colliding name anywhere — `useMcpState({name: 'customers'})` collides with `useMcpTool({name: 'customers.get_state'})`. |
| The surface name would derive a reserved name (`dom.`, `runtime.`) | Refused at declaration. |
| `getState` returns something the schema forbids | Refused **after** the getter ran, with the output-violation code — never the arguments code. |
| `getState` returns something unserializable | Refused. Never truncated, never partially sent. |
| `getState` throws | The agent receives an execution error; your page keeps running. |
| `getState` hangs | The call is raced against cancellation and settles regardless. |

---

## Related

- [Declaring a tool](declaring-a-tool.md) — the mutating half, and who on the page can call what you
  declare
- [Observing tool calls](observing-tool-calls.md) — watching reads go past, and which gate refused one
- [Connecting to an agent](connecting-to-an-agent.md) — the provider, capabilities and the socket
