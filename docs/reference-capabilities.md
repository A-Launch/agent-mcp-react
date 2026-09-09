# Capabilities and the gate chain

What an agent may reach on your page, how you say so, and the order in which every call is decided.

`capabilities` is a **required** prop on `AgentMcpProvider`. There is no default profile: an absent
member denies. That is deliberate — a library that picked a default would be deciding, on your behalf,
what an agent may do to your users' data.

```tsx
<AgentMcpProvider
  capabilities={{
    application: true,
    dom: { inspect: false, interact: false },
    evaluate: false,
  }}
  /* … */
>
```

---

## The shape

```ts
interface AgentCapabilities {
  readonly application: boolean;
  readonly dom: Readonly<Record<DomAuthority, boolean>>;  // { inspect, interact }
  readonly evaluate: boolean;
}
```

`dom` is a **pair, not a boolean**, because reading a page and acting on it are different authorities.
A read-only profile is exactly `{ inspect: true, interact: false }`.

An unknown member, or a member carrying a value that is neither a boolean nor `undefined`, is refused:
the provider reports `MCP_CAPABILITIES_UNUSABLE`, starts nothing and denies every bridged call. It
never guesses. A member that is **absent**, or present and explicitly `undefined`, is not an error —
it is `false`, because absent is denied.

`useMcpCapabilities()` publishes the granted set to your components, **frozen at its source** — an
application that could write `capabilities.application = true` at run time would have a capability
model in name only.

## The three levels

A level is decided by **which table a tool came from**, never by its name.

| Level | Constant | What it is | Admitted by |
|---|---|---|---|
| 1 | `CONTROL_LEVEL.application` | The tools you registered — `customers.set_filters`. The same actions your UI calls. | `application` |
| 2 | `CONTROL_LEVEL.dom` | `dom.snapshot`, `dom.get_text`, `dom.click`, `dom.fill` … roles and accessible names only. | `dom.inspect` / `dom.interact` |
| 3 | `CONTROL_LEVEL.evaluate` | `runtime.evaluate`. Arbitrary code in your page's origin. | `evaluate` |

**One level confers nothing on another.** `application: true` does not make a DOM tool callable;
`dom.inspect` does not imply `dom.interact`; nothing short of `evaluate` reaches Level 3.

Levels 2 and 3 are a closed build-time set the library ships and **never registers**. They are absent
from the document's shared registry in every configuration, including the one that granted them — see
[the blast radius of each level](explanation-reachability.md#the-three-levels-and-what-each-one-costs-you).

`RESERVED_PREFIX` — `dom.` and `runtime.` — is a collision guard so the two namespaces cannot be
confused by a reader. A registration whose name starts with one is refused at declaration
(`MCP_TOOL_NAME_RESERVED`). It is **not** the boundary; the table a tool came from is.

## Per-tool permissions

A tool can say two things about itself:

```ts
useMcpTool({
  name: 'invoice.mark_paid',
  permissions: {
    available: invoice.status !== 'void',   // absent means available
    confirmation: 'required',
  },
  /* … */
});
```

| Field | Effect | Enforced |
|---|---|---|
| `available` | When `false`, the call is refused `MCP_TOOL_DISABLED` **and** the tool is excluded from `tools/list`. The exclusion is for the agent's picture of the page; the refusal is the control. | At invocation |
| `confirmation: 'required'` | A person answers **before** the handler runs, never by undoing an effect afterwards. | Gate step 6 |

`risk` — `read` | `write` | `destructive` | `privileged` — **does not ship**. The vocabulary exists so
the feature that lands it cannot spell a level as a literal, but nothing reads it today, and MCP's
annotations schema strips it in transit. It would enforce nothing and could only mislead.

**These govern this library's bridge, not your page.** A tool marked `available: false` is still in the
shared document registry and still runs for any script on the page. Moving a domain rule out of a
handler and into `available` stops enforcing it for every caller that is not this agent.

## The gate chain

Every call passes these in order. `GATE_CHAIN` in `src/runtime/gate-chain.ts` is the authoritative
answer to "is that checked yet?", and it is verified by **driving a call**, not by reading the constant.

| # | Step | Decides | State |
|---|---|---|---|
| 1 | `authenticate` | Whether this connection may exist at all. **Identity only, never authorization.** | `elsewhere` — the gateway does it at the socket upgrade |
| 2 | `resolve` | Whether the named tool is one this library registered. Unknown, foreign and diverged each get their own cause. | built |
| 3 | `capability` | Whether the tool's control level is admitted, **read live at the moment of the call**. | built |
| 4 | `policy` | Per-tool availability, read live from what the application declared. | built |
| 5 | `validate` | Whether the arguments match the declared schema. In the runtime, never inside a handler. | built |
| 6 | `confirm` | Whether a person approved. The resolver sees a detached, deeply frozen snapshot of the validated arguments. | built |
| 7 | `invoke` | Nothing — it is the call itself, through the handler read at invocation so it sees current state. | built |

Two details worth knowing:

- **Capabilities are read live.** A copy taken when the runtime was built would keep admitting calls
  after an operator withdrew a capability. Capability, availability and cancellation are all re-read
  when a confirmation answers, because a confirmation is human-scale and any of them can change while
  one is open.
- **Step 1 is `elsewhere` on purpose.** Authentication happens at the socket upgrade, not in the
  runtime. Marking it built would make the case that drives a call through every built step go red,
  correctly.

`REFUSED_BECAUSE` names the **decision** — `capabilityDenied`, `unavailable`,
`noConfirmationResolver`, `confirmationRefused` — and the runtime maps a decision onto what the agent
is told. They are separate vocabularies so a decision can be made and asserted with no protocol layer
anywhere near it.

## What the library redacts, and what it does not

This is the part to read twice.

**Unconditional, in the library:**

- A DOM snapshot decides an input's **kind before it reads the value**, and a `password` or `hidden`
  input returns without one. The ordering is the guarantee: there is no path on which a password's
  value is read and then discarded, so nothing downstream has to be trusted to drop it. A text input's
  value *is* reported — the snapshot shows what is on screen — so an application that puts a secret in
  an ordinary text field has disclosed it, and that is the application's decision rather than the
  library's.
- Hidden inputs are not exposed.
- A validation refusal names the field, the expected type and the permitted set, and **never the
  received value**. That was a real leak once: a call carrying `{password: 'secret'}` sent the password
  back to the agent in the diagnostic.
- Nothing is ever included *automatically* — no token, no credential, no ambient state. The library
  traverses nothing and injects nothing.
- Connection credentials are scrubbed from everything the transport reports.

**Not the library's, and it cannot be:**

`useMcpState`'s schema is a **contract, not a redactor**. It is validated exactly as authored — never
rewritten into a closed variant, never used to project — so an undeclared field in what your `getState`
returns **does** reach the agent. Synthesizing `additionalProperties: false` was assessed and rejected:
a closed schema cannot express secrecy even when perfectly implemented (`user: { type: 'object' }`
passes everything beneath it), and it would advertise one contract while enforcing another.

**Your `getState` is the disclosure boundary.** There is exactly one place to get it wrong, which is
better than several. See [Exposing state](exposing-state.md), which shows the leaking one-liner as an
anti-example because it is shorter than the right version.

## The scenario matrix

Each row is a **negative case**, and every one asserts the refusal **at the call** — not absence from
`tools/list`. They are grouped by the gate step that decides them, so a row also tells you where the
decision lives.

In the **Granted** column, a member that is not listed is `false`. The two halves of `dom` are named in
full, because which half was granted is usually the whole point of the row. **Level** is the tool's
control level; **Permissions** is what the tool declared about itself.

### Step 2 — resolve

| Granted | Level | Permissions | The call | Verdict |
|---|---|---|---|---|
| `application` | 1 | — | a name nothing ever registered | `MCP_TOOL_NOT_FOUND` |
| `application` | 1 | — | a tool whose component unmounted, from a listing taken before it did | `MCP_TOOL_NOT_FOUND` |
| `application` | 1 | — | a name another script put in the shared registry | `MCP_TOOL_NAME_HELD_BY_FOREIGN_OWNER`, and it was never listed |
| `application` | 1 | — | a name the ownership record holds that the registry does not | `MCP_REGISTRY_OWNERSHIP_DIVERGED`; every other tool is unaffected. The reverse — in the registry, not in the record — is the foreign case above |
| `dom.inspect` | 2 | — | `dom.snapshot`, in an application that never supplied the DOM tools | `MCP_TOOL_NOT_FOUND` — a granted capability is not a tool |

### Step 3 — capability

| Granted | Level | Permissions | The call | Verdict |
|---|---|---|---|---|
| nothing | 1 | — | any tool you registered, over the bridge | `MCP_TOOL_CAPABILITY_DENIED`, and the tool stays in `tools/list` |
| nothing | 1 | — | that same tool, from a script on the page | it runs — a capability gates the bridge, not the page |
| `application` | 2 | — | `dom.snapshot` | `MCP_TOOL_CAPABILITY_DENIED`, naming `dom.inspect` |
| `application`, `dom.inspect` | 2 | — | `dom.click` | `MCP_TOOL_CAPABILITY_DENIED`, naming `dom.interact` |
| `application`, `dom.interact` | 2 | — | `dom.snapshot` | `MCP_TOOL_CAPABILITY_DENIED` — the separation runs both ways |
| `application`, `dom.inspect`, `dom.interact` | 3 | — | `runtime.evaluate` | `MCP_TOOL_CAPABILITY_DENIED` — one level confers nothing on another |
| everything, `evaluate` included | — | — | enumerating `document.modelContext` from the page | this library has put no `dom.*` and no `runtime.evaluate` handler there, in any configuration. Another script on the page may still register those NAMES, and the bridge resolves its own built-in first, so what it registered is not what the agent reaches |

A refusal names the capability **down to the authority** — `dom.interact`, not `dom` — because "you
were not granted dom" is false in exactly the profile that granted the other half.

### Step 4 — policy

| Granted | Level | Permissions | The call | Verdict |
|---|---|---|---|---|
| `application` | 1 | `available: false` | the tool | `MCP_TOOL_DISABLED`. It is excluded from `tools/list` as well; the exclusion is not the control |
| `application` | 1 | `available` absent | the tool | admitted at this step — an absent `available` means available |

### Step 5 — validate

| Granted | Level | Permissions | The call | Verdict |
|---|---|---|---|---|
| `application` | 1 | — | an argument the declared schema rejects | `MCP_TOOL_ARGUMENTS_INVALID`; the handler is never entered and the rejected value is never echoed back |
| `application` | 1 | — | a tool whose validator itself failed to run | `MCP_TOOL_ARGUMENTS_INVALID`, handler never entered — a contract that could not be checked is not a contract that passed |
| `dom.interact` | 2 | — | `dom.press` with a key outside the closed set | `MCP_TOOL_ARGUMENTS_INVALID` |

### Step 6 — confirm

| Granted | Level | Permissions | The call | Verdict |
|---|---|---|---|---|
| `application` | 1 | `confirmation: 'required'`, no resolver wired | the tool | `MCP_TOOL_CONFIRMATION_UNAVAILABLE`; the handler is never entered |
| `application` | 1 | `confirmation: 'required'` | a person dismisses it, or the resolver throws or returns anything that is not `'approved'` | `MCP_TOOL_CONFIRMATION_REFUSED`; the handler is never entered |
| `application` | 1 | `confirmation: 'required'` | the capability is withdrawn while the prompt is open, and a person then approves | `MCP_TOOL_CAPABILITY_DENIED` — capability, availability and cancellation are all re-read when a confirmation answers |
| `evaluate` | 3 | `confirmation: 'required'`, declared by the built-in | `runtime.evaluate` with no resolver wired | `MCP_TOOL_CONFIRMATION_UNAVAILABLE`, and the tool stays listed — a fact about the deployment, not about the tool |
| `evaluate` | 3 | `confirmation: 'required'` | a person declines | `MCP_TOOL_CONFIRMATION_REFUSED`, and the expression never ran |

### Before any call — declaration and the provider

| Granted | Level | Permissions | What happens | Verdict |
|---|---|---|---|---|
| any | — | — | an application declares a tool named `dom.click` | `MCP_TOOL_NAME_RESERVED`, at declaration; it never reaches the registry |
| any | — | — | a declared tool is renamed **into** `dom.*` | `MCP_TOOL_NAME_RESERVED`, and the registration that was standing is withdrawn rather than left holding the old name |
| a set carrying an unknown member, or one that is not a boolean | — | — | mounting the provider | a development build throws from the render; a production build reports `MCP_CAPABILITIES_UNUSABLE` through `onUnexpectedState`, starts nothing and denies every bridged call |
| a set with a member simply absent | — | — | mounting the provider | it serves; the absent member denies its own level and nothing else |
| any | — | — | an application writes to the set `useMcpCapabilities()` returned | `TypeError` — the set is frozen at its source, so publishing the connection's authority cannot widen it |
| any | — | — | a second `AgentMcpProvider` mounts in one document | `MCP_REACT_PROVIDER_ALREADY_ACTIVE`, carrying the holder that is already active |

### The connection

| Granted | Level | Permissions | The call | Verdict |
|---|---|---|---|---|
| — | — | — | connecting with no ticket, or with one already spent | refused at the HTTP upgrade, before the handshake: no `open` fires and no session is established. The page is told `MCP_WS_CONNECTION_FAILED`, which it cannot tell apart from a gateway that is down. There is no authentication-specific code |
| `application: false` | 1 | — | a valid ticket, then a tool call | still `MCP_TOOL_CAPABILITY_DENIED` — see [why identity is not authorization](explanation-reachability.md#why-identity-is-not-authorization) |

### Levels 2 and 3, once they are admitted

| Granted | Level | Permissions | The call | Verdict |
|---|---|---|---|---|
| `dom.inspect` | 2 | — | `dom.snapshot` over a password field | the element is reported with its role and its name, and no value is carried for it — an agent must be able to see that a password is being asked for |
| `dom.inspect` | 2 | — | `dom.snapshot` over hidden inputs | they are not in the snapshot at all: a hidden input is not perceivable, so it is excluded before any value is considered |
| `dom.interact` | 2 | — | a reference used after the page moved on — including a node React recycled into a different row | `MCP_DOM_REF_STALE`, carrying an instruction to take a new snapshot |
| `dom.interact` | 2 | — | a reference this document never issued | `MCP_DOM_REF_NOT_FOUND`, and deliberately **no** re-snapshot instruction: re-snapshotting cannot conjure a token nobody minted |
| `dom.interact` | 2 | — | `dom.click` on a `disabled`, `inert` or `pointer-events: none` element | `MCP_DOM_NOT_INTERACTABLE`, naming which — decided here, before anything is dispatched |
| `dom.interact` | 2 | — | `dom.fill` on a read-only field, a `<select>`, or a `contenteditable` | `MCP_DOM_NOT_INTERACTABLE` |
| `evaluate` | 3 | — | an expression returning a function | `MCP_RUNTIME_EVALUATE_RESULT_NOT_CARRIABLE`, naming the kind — never an empty success |
| `evaluate` | 3 | — | evaluating under a `script-src` with no `unsafe-eval` | `MCP_RUNTIME_EVALUATE_FORBIDDEN`, kept distinct from `MCP_RUNTIME_EVALUATE_SYNTAX`: a correct page configuration is not a malformed expression |
| `application` | 1 | — | a handler that throws | `MCP_TOOL_EXECUTION_ERROR`, composed from this library's own vocabulary. The handler's message is not passed through, nothing escapes into the page, and a development build attaches the underlying cause where production does not |

## Where the evidence must land

Every row above is a test somewhere, and the layer is not a matter of taste: a case belongs where the
thing it asserts is reachable. The conventions themselves — including the one that governs all of
these, that a capability or redaction case asserts the **refusal at invocation** and never merely
absence from `tools/list` — are in
[the testing section of CONTRIBUTING](../CONTRIBUTING.md#8-testing).

| Layer | The capability and redaction evidence that belongs there |
|---|---|
| `tests/unit/security/` | The decision alone: which level a set admits, which half of `dom`, how an unreadable set is reported. No I/O, so the negative suite over it is exhaustive rather than illustrative |
| `tests/unit/dom/`, `tests/unit/evaluate/` | Redaction and interactability where the module decides them — a password value, a hidden input, a read-only field, a result that cannot be carried |
| `tests/react/` | The lifecycle half: a tool that exists after commit and is gone after unmount, a reserved rename that withdraws what was standing, a frozen published capability set |
| `tests/transport/` | Every gate refusal driven **end to end over a real socket**, and the enumeration of the page's shared registry that proves Levels 2 and 3 are not in it |
| `tests/integration/` | The ordered scenario over one application: a tool leaves the listing when a route changes, and the next call to it is refused |
| `tests/e2e/` | What only a real browser can catch — bundling, the server-rendering boundary, real socket closure, evaluation refused by a content security policy, page-level redaction |

Three rules that decide the layer when more than one looks plausible:

- **Assert through what an MCP client would see**, not only through this library's own registry. A
  registry read that agrees with a broken `tools/list` is a test of the registry.
- **A case that cannot tell which layer it is testing goes green when the wrong one is deleted.** A
  hidden input is refused twice — once for having no role in the vocabulary, once for not being
  perceivable — so one assertion at the top proves neither guard. Assert each where it is the only
  thing standing.
- **Break it to prove it.** For every row above, deleting the check that produces the verdict must
  turn that case red. A row that stays green with its gate removed was never testing it.

## Related

- [The error vocabulary](reference-error-vocabulary.md) — every code a gate can produce
- [Declaring when a tool may be reached](declaring-a-tool.md#declaring-when-a-tool-may-be-reached)
- [Observing tool calls](observing-tool-calls.md) — which step decided, on both call routes
- [What each level costs you](explanation-reachability.md) — the blast radius, and why identity is not authorization
- [DOM inspection](dom-inspection.md) · [JavaScript evaluation](javascript-evaluation.md)
