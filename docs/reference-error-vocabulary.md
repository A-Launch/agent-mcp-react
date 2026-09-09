# The error vocabulary

Every failure this library can report, what raises it, and who is allowed to see it.

The codes are **closed dictionaries** — one exported `as const` object per concern, with the type and
the membership test derived from it. Nothing here is a free-form string, and nothing outside the
library can add a member. If you are handling a failure, compare against the exported constant rather
than the literal: `RUNTIME_FAILURE.toolNotFound`, not `'MCP_TOOL_NOT_FOUND'`.

**Five of the six are exported; `TRANSPORT_FAILURE` is not.** `RUNTIME_FAILURE`, `REGISTRY_UNAVAILABLE`,
`REGISTRATION_REFUSED`, `CLAIM_REFUSED` and `REACT_REFUSED` come from `agent-mcp-react`. The four
`MCP_WS_*` codes reach you only as the `code` on a failure the provider reports, so there is no constant
to compare against and matching the literal is what you have.

Where each dictionary lives:

| Dictionary | Module | What it names |
|---|---|---|
| `RUNTIME_FAILURE` | `src/runtime/errors.ts` | Everything that can refuse or break a **call** |
| `REGISTRY_UNAVAILABLE` | `src/webmcp/errors.ts` | Why the document's tool registry could not be used at all |
| `REGISTRATION_REFUSED` | `src/webmcp/errors.ts` | Why a **registration** was refused |
| `CLAIM_REFUSED` | `src/webmcp/errors.ts` | Why this provider could not claim the page |
| `REACT_REFUSED` | `src/react/errors.ts` | Misuse of the React surface, in your code |
| `TRANSPORT_FAILURE` | `src/transport/errors.ts` | The socket |

---

## Call failures — `RUNTIME_FAILURE`

These are what an agent sees when a call does not succeed. They are ordered here the way the
[gate chain](reference-capabilities.md#the-gate-chain) reaches them, because that order is also the
answer to "why was this refused rather than that".

### The tool could not be resolved

| Code | Raised when |
|---|---|
| `MCP_TOOL_NOT_FOUND` | No tool of that name is registered by this application. **This is the code a removed component produces** — see [why that is the design](explanation-reachability.md#a-tool-that-is-gone-is-not-a-tool-that-says-no). |
| `MCP_TOOL_NAME_HELD_BY_FOREIGN_OWNER` | The name exists in the document's registry, but another script on the page put it there. The library will not bridge a tool it did not register. |
| `MCP_REGISTRY_OWNERSHIP_DIVERGED` | The registry and the library's ownership record disagree about a name. Treated as an alarm, never filtered away. |

### The call was refused by a gate

| Code | Raised when |
|---|---|
| `MCP_TOOL_CAPABILITY_DENIED` | The tool's control level is not admitted by this connection's capability set. Names the capability an operator would have to grant. |
| `MCP_TOOL_DISABLED` | The tool declared `permissions.available: false` at the moment of the call. |
| `MCP_TOOL_ARGUMENTS_INVALID` | The arguments do not match the declared schema. Names the field, the expected type and the permitted set — and **never the received value**. |
| `MCP_TOOL_CONFIRMATION_UNAVAILABLE` | The tool declares `confirmation: "required"` and no resolver was supplied to the provider. Fails safe: no prompt appears and nothing runs. |
| `MCP_TOOL_CONFIRMATION_REFUSED` | A person declined, or the resolver failed to produce a decision. Anything that is not an approval denies. |
| `MCP_CAPABILITIES_UNUSABLE` | The `capabilities` prop itself could not be read — an unknown member, a member that is not a boolean, or a set that would not answer. The provider refuses to serve rather than guessing. An absent member is not an error: it is `false`. |

### The call ran and did not finish cleanly

| Code | Raised when |
|---|---|
| `MCP_TOOL_EXECUTION_ERROR` | **Your handler threw.** The original message is replaced outside a development build — see [Throwing loses your message](#throwing-loses-your-message) below. |
| `MCP_TOOL_RESULT_NOT_SERIALIZABLE` | The handler returned something that cannot cross the wire. |
| `MCP_TOOL_RESULT_VIOLATES_OUTPUT_SCHEMA` | The result does not match the declared `outputSchema`. This is the bridge's code; a page-script call is refused against the same compiled schema and gets `MCP_REACT_RESULT_VIOLATES_OUTPUT_SCHEMA`. |
| `MCP_TOOL_CALL_CANCELLED` | The agent cancelled, or the tool stopped being declared while the call was in flight. |
| `MCP_TOOL_CALL_ABANDONED` | The call settled in no other way — the backstop that guarantees every call produces an outcome. |

### Declaration-time and infrastructure

| Code | Raised when |
|---|---|
| `MCP_TOOL_SCHEMA_NOT_COMPILABLE` | A declared schema could not be compiled. |
| `MCP_TOOL_VALIDATOR_MISSING` | A tool declares a schema and no validator is installed. **The tool is not registered at all**, so there is no configuration where validation is silently skipped. |
| `MCP_REACT_NOT_CONNECTED` | The runtime is not serving — nothing to call. |
| `MCP_TOOL_LIST_NOTIFICATION_FAILED` | The `tools/list_changed` notification could not be sent. The agent's picture of the page is now stale, which is why this is reported rather than swallowed. |

### Level 2 and Level 3

| Code | Raised when |
|---|---|
| `MCP_DOM_REF_STALE` | A DOM reference no longer matches the role and accessible name the snapshot published. Take another snapshot. |
| `MCP_DOM_REF_NOT_FOUND` | The reference is not in the current table at all. |
| `MCP_DOM_NOT_INTERACTABLE` | The element cannot be operated — `disabled`, `inert`, `pointer-events: none`. Decided **before** anything is dispatched, because a synthetic click bypasses some of these and the platform silently swallows others. |
| `MCP_RUNTIME_EVALUATE_SYNTAX` | The expression did not compile. |
| `MCP_RUNTIME_EVALUATE_FORBIDDEN` | Policy refused the expression. |
| `MCP_RUNTIME_EVALUATE_RESULT_NOT_CARRIABLE` | The expression returned something that cannot cross the wire. |

---

## Throwing loses your message

**This is the rule that changes how you write a handler**, and it is not obvious from the types.

A handler that throws is reported as `MCP_TOOL_EXECUTION_ERROR: the tool "…" failed while running`.
The original message is appended **only** when `NODE_ENV=development`.

That suppression is correct. An exception can carry internals, a stack, or a value the agent was never
meant to see, and a production build must not send those. The consequence for your application:

> **Guidance the agent should act on has to be RETURNED, not thrown.**

"That kind does not accept that source, it accepts these" is information, not a crash. Return it:

```ts
handler: async (input) => {
  try {
    return { ok: true, ...apply(input) };
  } catch (cause) {
    // A refusal the agent can read and act on.
    return { ok: false, refused: cause instanceof Error ? cause.message : String(cause) };
  }
}
```

Two refusal routes, and they are different on purpose:

| Route | Shape | Example |
|---|---|---|
| The runtime, before your handler | `isError: true`, naming the field and the permitted set | an undeclared property; a value outside an `enum` |
| Your application, from the handler | whatever you return — `ok: false` with a reason | a domain rule; a limit; an unknown identifier |

### `HANDLER_REPORTABLE` — the one exception, and it is not yours

A small closed subset of `RUNTIME_FAILURE` may be reported *by* a handler rather than mapped to
`MCP_TOOL_EXECUTION_ERROR`: `MCP_DOM_REF_STALE`, `MCP_DOM_REF_NOT_FOUND`,
`MCP_DOM_NOT_INTERACTABLE`, and the three `MCP_RUNTIME_EVALUATE_*` codes.

It is a **library-owned set an application cannot join**. The reason is specific: a handler is code
this library did not write, and a handler that could name any member could claim
`MCP_TOOL_CAPABILITY_DENIED` — falsifying the record of a gate that in fact admitted the call, on the
one surface an operator uses to answer "why was this refused".

---

## Registry failures — `REGISTRY_UNAVAILABLE`

Why the document's tool registry could not be used at all. These arrive through
`onUnexpectedState`, not through a call.

| Code | Meaning |
|---|---|
| `MCP_REGISTRY_NO_DOCUMENT` | No document — server-side rendering, or a worker. |
| `MCP_REGISTRY_INSECURE_CONTEXT` | The page is not a secure context. |
| `MCP_REGISTRY_FEATURE_NOT_PERMITTED` | Permissions policy forbids the feature. |
| `MCP_REGISTRY_HOSTS_DIVERGED` | Two hosts disagree about the registry. |
| `MCP_REGISTRY_INSTALL_REFUSED` | The portability shim could not be installed. |

## Registration failures — `REGISTRATION_REFUSED`

| Code | Meaning |
|---|---|
| `MCP_TOOL_NAME_DUPLICATE` | This application already registered that name. Development **throws and names the source**; production rejects the later registration and preserves the original. |
| `MCP_TOOL_NAME_HELD_BY_FOREIGN_OWNER` | Another script on the page holds the name. |
| `MCP_TOOL_NAME_RESERVED` | The name starts with `dom.` or `runtime.` — refused at declaration, synchronously, before anything else is attempted. |
| `MCP_TOOL_REGISTRATION_WITHDRAWN` | The registration was withdrawn while in flight. |
| `MCP_TOOL_REGISTRATION_CHURNING` | A descriptor is changing fast enough to be a re-registration storm. |
| `MCP_TOOL_REGISTRATION_REFUSED` | The registry refused, for its own reason. |

## Page-claim failures — `CLAIM_REFUSED`

| Code | Meaning |
|---|---|
| `MCP_REACT_PROVIDER_ALREADY_ACTIVE` | A second `AgentMcpProvider` tried to claim the same document. One provider per document — a second is a second MCP server on one page, which presents as every tool call happening twice rather than as an error. |
| `MCP_CLAIM_NOT_THE_HOLDER` | Something tried to release a claim it does not hold. |
| `MCP_CLAIM_MARKER_UNUSABLE` | The claim marker could not be read or written. |

## React-surface failures — `REACT_REFUSED`

These are **your** mistakes, reported where you can fix them.

| Code | Meaning |
|---|---|
| `MCP_REACT_PROVIDER_MISSING` | A hook was used outside `AgentMcpProvider`. |
| `MCP_REACT_ARGUMENTS_INVALID` | A hook was called with arguments it cannot use. |
| `MCP_REACT_CONNECTION_TRANSITION_FORBIDDEN` | An illegal connection-state transition. |
| `MCP_REACT_TOOL_NOT_DECLARED` | A handle was used for a tool that is not declared. |
| `MCP_REACT_OBSERVER_FAILED` | One of your observation callbacks threw. |
| `MCP_REACT_STATE_SCHEMA_MISSING` | `useMcpState` was given no schema. |
| `MCP_REACT_RESULT_VIOLATES_OUTPUT_SCHEMA` | A tool called through the shared document registry returned something that does not match its declared output schema, or that cannot be serialized. |

## Transport failures — `TRANSPORT_FAILURE`

| Code | Meaning |
|---|---|
| `MCP_WS_URL_UNAVAILABLE` | Your `getUrl` did not produce a URL. |
| `MCP_WS_CONNECTION_FAILED` | The socket did not open, or closed during the handshake. Credential text is scrubbed from everything this reports. |
| `MCP_WS_CHANNEL_NOT_OPEN` | A send was attempted on a channel that is not open. |
| `MCP_WS_FRAME_NOT_A_MESSAGE` | A frame arrived that is not one MCP JSON-RPC message. |

---

## Related

- [Declaring a tool](declaring-a-tool.md) — the contract these failures police
- [Capabilities and the gate chain](reference-capabilities.md) — which step produces which refusal
- [Observing tool calls](observing-tool-calls.md) — how to see which gate step decided
- [Why absence from `tools/list` is not access control](explanation-reachability.md)
