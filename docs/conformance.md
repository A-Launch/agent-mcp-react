# The conformance layer — adopted behaviour

**A documented claim is not a verified one.** The design states the rule (see
[testing strategy](design.md#testing-strategy)):

> Every behaviour the library relies on in an adopted package or in the browser's registry is owed a
> case in this repository, and no requirement is claimed against such a behaviour before its case
> passes.

The reason is not a formality: *"a dependency's documentation describes what its authors intended, not
what the resolved version does, and the failure surfaces in a browser channel nobody ran."*

Cases live in `tests/conformance/` and run in the `unit` project. They need no server and no browser,
so they cost nothing to keep and cannot be skipped.

## The rows

| Behaviour | Where | State |
|---|---|---|
| The layer declines to install over a registry already at the canonical location | `registry-precedence.spec.ts` | ✅ |
| A second initialization changes nothing | `registry-precedence.spec.ts` | ✅ |
| Both host objects resolve to the same registry | `registry-precedence.spec.ts` | ✅ |
| A duplicate name is refused | `registry-registration.spec.ts` | ✅ |
| …and refused **synchronously**, before a promise exists | `registry-registration.spec.ts` | ✅ |
| A withdrawn name becomes registrable again | `registry-registration.spec.ts` | ✅ |
| Aborting a registration's signal withdraws the tool | `registry-registration.spec.ts` | ✅ |
| Withdrawal is idempotent under a double-invoked effect | `registry-registration.spec.ts` | ✅ |
| A deprecated-host-only registry registers **and invokes** | `registry-registration.spec.ts` | ✅ |
| The MCP SDK's server runs in a browser bundle | `tests/e2e/conformance-bundle.spec.ts` | ✅ |
| The bundle works with every Node global absent | `tests/e2e/conformance-bundle.spec.ts` | ✅ |
| **React ≥ 18 works, as the peer range declares** | — | ⬜ **open** |
| **A native registry agrees with the shim on abort-driven withdrawal under a double-invoked effect** | — | ⬜ **open** |

## Conformance against the WebMCP draft

The rows above pin what the **adopted package** does. This section pins what the **standard says**, and
where the two differ.

| | |
|---|---|
| Source | `webmachinelearning/webmcp`, `index.bs` |
| Commit | **`41d12f057167ccf5954dbcf49d99502cb6c84491`** |
| Date | **2026-08-26** |
| Held at | [`tests/conformance/evidence/`](../tests/conformance/evidence/) |

**The method is the finding.** Every claim below is read from the **WebIDL and the algorithm steps** at
that commit — never from a summary, and never from the package. Two of this review's four questions had
already been answered *wrongly* by widely-cited public documentation, and in both cases a reviewer
trusting it would have filed a false finding against this library.

**WebMCP is a W3C Web Machine Learning Community Group standard**, authored by Google and Microsoft.
It is not OpenAI's, and a review measured against the wrong document is worthless.

### Findings

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | The registry lives at `document.modelContext`, as this library assumes | **CONFIRMED** | `partial interface Document { [SecureContext, SameObject] readonly attribute ModelContext modelContext; }` |
| 2 | The registry descriptor has no output-schema field (`listing.ts`) | **CONFIRMED** | `outputSchema` appears **zero times**; `ModelContextTool` declares six members and none is it |
| 3 | A duplicate name is refused | **CODE CONFORMANT ON BOTH CHANNELS** | The standard **rejects**; the package **throws**. See below |

#### 1 — Host object: confirmed, and nearly filed as a defect

A widely-cited summary of the February 2026 draft places the registry on `Navigator`, and the resolved
package still warns that `navigator.modelContext` is deprecated as of the 2026-05-27 draft (PR #184).
**A review that trusted the summary would have "corrected" this library into non-conformance.** The
normative text at the pinned commit says `Document`. No change.

#### 2 — Output schema: confirmed, with a package divergence this project is immune to

`src/runtime/listing.ts` is right, and the design resting on it stands: an output schema reaches an
agent through the ownership record because it cannot come back from the registry.

**The resolved package implements `outputSchema` anyway** and validates against it. This library never
sets the field — asserted by `registry-descriptor-shape.spec.ts` — so it is unaffected. An application
setting it directly would get validation on the polyfill and silence on a conformant registry.

#### 3 — Duplicate names: three sources, three behaviours

| Source | Behaviour |
|---|---|
| **The standard** | *"If |tool map|[|tool name|] exists, then return a promise **rejected** with an `InvalidStateError` `DOMException`"* |
| **The resolved package** | **Throws synchronously** — `Tool already registered: <name>` |
| A February summary | Said it **replaces**. It does not, in either implementation |

**The code is conformant against both**, because `src/webmcp/registry.ts` writes `try { await … }`,
which catches a synchronous throw *and* a rejection. It is more robust than the justification written
above it, which describes only the throw.

**The comment above it is load-bearing.** It names both channels, because it is what stops a
contributor refactoring to `.catch()` — a change that would be **safe against the standard and broken
against the package this project actually runs**. Both behaviours are pinned: the synchronous throw by
`registry-registration.spec.ts`, the rejection channel by `registry-duplicate-timing.spec.ts`.

### Three further divergences, found by reading the IDL rather than by asking a question

None of these was one of the four questions. They are recorded because a reader who trusts the
resolved package's shape is trusting an implementation, not the standard — and the difference only
shows up on a native registry — which this repository CAN now reach, and does, in
`tests/e2e/native-registry/`.

| | Normative | The resolved package | **Chromium 151** |
|---|---|---|---|
| `ToolAnnotations` | `readOnlyHint`, `untrustedContentHint` | keeps all five it accepts — the normative two plus `destructiveHint`, `idempotentHint`, `openWorldHint` | **the normative two**; the other three are dropped |
| `executeTool` input | `optional object inputObject` | `inputArgsJson` — a **JSON string** | **a JSON string** — an object is refused |
| `execute`'s 2nd argument | `ToolExecuteCallbackOptions { required AbortSignal signal }` | `{ requestUserInteraction }` | **no second argument at all** |

**Read the third column before drawing a conclusion from the first two.** The natural inference from
"the package diverges from the standard" is that the standard describes what a browser does. On
`executeTool` that is exactly backwards: **the draft is the outlier and both implementations agree.**
The package's JSON string is not a deviation this project tolerates — it is what Chromium requires.

**Annotations: inert here.** `src/webmcp/descriptor.ts` does not let a caller set them, so this
library never spells a field the standard does not have.

**`executeTool`: live here, in a test.** `tests/conformance/registry-registration.spec.ts` invokes
`executeTool(info, JSON.stringify({}))` — the package's signature. **The case is correct about what
this project runs against — and, measured, it PASSES against Chromium's native registry too, because
Chromium takes the JSON string and refuses the draft's object**. The divergence is real and the case is
on the right side of it. A note at the call site says so, so the next reader does not "fix" it into
something that fails today.

**The `signal` one is the sharpest, and it is now measured rather than watched.** The draft declares
the second argument REQUIRED. The package passes something else. **Chromium passes nothing at all** —
the handler's second parameter is `undefined`. So a library that had taken the specification at its
word and written `execute(args, { signal })` would be reading a property of `undefined` on the only
engine that implements this.

This library does not depend on it: cancellation comes from `src/runtime/`, which races the handler
itself (see [cancellation](design.md#cancellation)). That was a design choice made for its own reasons,
and this measurement is what turns it from a preference into the thing that kept the feature working.

## What of the standard this library does not implement

Enumerated against the pinned draft's IDL rather than recalled, so a reader can tell a decision from
an omission. **Every unimplemented member below is one of four things**, and the difference is the
whole point of the table: a non-goal, a role mismatch, a deliberate substitution, or genuinely open.

### Deliberate non-goals — these will not ship

| Member | Why |
|---|---|
| `exposedTo` on `registerTool` | Cross-origin exposure is a [non-goal](design.md#non-goals) |
| `fromOrigins` on `getTools` | Same |
| `annotations` on `ModelContextTool` | The draft's annotations are hints to a caller and never enforcement; this project derives risk from its own vocabulary and does not let one be set through the boundary (`src/webmcp/descriptor.ts`) |

**The first two are load-bearing rather than ceremonial, and that was measured.** Chromium implements
both fully — a tool registered with `exposedTo` IS returned to a parent enumerating with
`fromOrigins`. Passing either would genuinely widen this library from same-origin to cross-origin,
which is why their absence is asserted on the actual call arguments in
`tests/conformance/enumeration-origin-scope.spec.ts` rather than trusted to code review.

### Not applicable — this library is the SERVER, not a client of the registry

**`executeTool()` is never called from `src/`.** Tool calls arrive over the socket and dispatch
through the ownership record; the registry's own invocation path is for page scripts and in-page
agents. `ModelContextExecuteToolOptions` follows it out of scope.

### A deliberate substitution

**`ontoolchange`** is not assigned; `addEventListener('toolchange')` is used instead. On a registry
**shared with every script on the page**, assigning the attribute would silently replace another
script's handler. The listener form composes; the attribute form does not.

### Read but not used

- **`RegisteredTool.window`** — never read. `src/runtime/listing.ts` records why keying the
  foreign-entry exclusion on it would invert the authority.
- **`RegisteredTool.origin`** — carried onto `RegistryEntry` by `fromRegistryEntry` and **never
  consumed downstream**. Not a defect; it is carrying-cost with no reader, and it is written down
  here so the next person to touch that type knows it is unused rather than load-bearing.

### The contract neither implementation honours

**`ToolExecuteCallbackOptions { required AbortSignal signal }`.** The draft marks it REQUIRED.
Chromium passes **no second argument at all**; the adopted package passes `{ requestUserInteraction }`,
a member that appears **zero times** in the draft. Handlers here read neither — cancellation comes
from `src/runtime/`, which races the handler (see [cancellation](design.md#cancellation)).

**A library that had taken the specification at its word and destructured `{ signal }` would be
reading a property of `undefined` on the only engine that implements this.** That the design does not
was a choice made for its own reasons; this measurement is what turned it into the thing that kept the
feature working.

### Genuinely open: Declarative WebMCP

Deriving a tool from a `<form>` and its form-associated elements. Nothing here touches it.

**Measured on Chromium 151** under plain `--enable-features=WebMCP` — it needs no separate flag:

```html
<form toolname="book_flight" tooltitle="Book a flight" tooldescription="Books a flight">
  <input name="destination" toolparamdescription="City to fly to" required>
  <input name="date" type="date" toolparamdescription="Date of travel">
</form>
```

That markup alone produced a tool in `getTools()`. **The synthesised schema is considered work rather
than a stub**, which matters because the draft leaves the algorithm as *"TODO: Derive a conformant
JSON Schema object"*: `required` became the required array, `type="date"` became `format: "date"`
**plus an appended instruction to the model** about the wire format, and a `<select>` became `enum`
AND `anyOf` with per-option titles.

**The execution model is the finding, and the draft specifies none of it** (*"Issue: Spec the
declarative execution steps"*):

| Step | Observed |
|---|---|
| `executeTool` with `{destination: "Lisbon"}` | the field is filled, and an **`input` event fires** |
| the form | is **NOT** submitted — no submit event |
| the promise | **stays pending** |
| a real user click on the submit button | the handler runs, and only then does the call settle |

**The agent fills the form; a human presses the button.** Human-in-the-loop lives in the platform
primitive rather than above it — a stronger gate than this library's own
`permissions.confirmation`, and the fill travels the platform's own event path rather than needing
the native-setter technique `src/dom/` exists for.

**Two structural facts, and the tension they create.** The draft has not specified this while Chromium
ships ahead of the text, under `kDeclarativeWebmcp`. And it sits against invariant 1: *a tool exists
only by registration; no discovery, no convention, no inference*. Markup is explicit author intent, so the
tension is arguable rather than fatal — but a declaratively registered tool **is not in this library's
ownership record, so `deriveListing()` excludes it as foreign and it never reaches the agent.** That
is correct under the current rule and may be the wrong outcome.

**That argument has not been had.** It is held as three candidate pieces of work, recorded so the
next cut is chosen rather than improvised, and the first of them is the argument itself and writes no
code:

1. **Position.** Whether a markup-declared tool is compatible with invariant 1 at all. Markup is
   explicit author intent, so this is arguable rather than settled; what it is NOT is a registration in
   an effect after commit, by code this library ran. Answered before anything is written.
2. **Bridge.** A declarative tool is not in this library's ownership record, so today it is excluded as
   foreign and never reaches the agent. Admitting one means a second kind of ownership entry, or a
   per-form application opt-in — and whichever it is, it must not weaken *"bridge only what this library
   registered"* into *"bridge what looks like ours"*.
3. **Execution.** A call that never settles until a human acts collides with the
   [cancellation design](design.md#cancellation), which races a handler so an agent cannot be hung. A
   pending-until-gesture call is not a hung handler; telling them apart is the work.

### Not this library's to implement

**Pending tool executions**, **event loop integration** and **page observations** are user-agent
obligations; the last is explicitly non-normative and describes browser-agent infrastructure.

**Permissions Policy is used partially and correctly.** The registry is gated behind the
policy-controlled feature `tools`, default allowlist `'self'`. This library queries it for diagnostics
(`REGISTRY_POLICY_FEATURE` in `src/webmcp/registry.ts`) and **never requests delegation** — relying on
the platform's default is one of the three independent things keeping the
[cross-origin non-goal](design.md#non-goals) true.

## What these cases do NOT evidence

**These cases do evidence behaviour against a real implementation, and the story of how that was
established is the most useful thing on this page.**

Two claims were recorded here across three revisions — *"no engine ships a native registry"*, then
*"an engine ships one, but it is behind an origin trial"*, the second supported by a probe showing
`undefined` on all three engines. Both were wrong, and
the probe that "confirmed" the second one was wrong in a way worth naming: **it ran on a `data:` URL.**
The registry's interface is `[SecureContext]`; a `data:` URL is an opaque origin. That probe reports
`undefined` on every engine with every flag ever, and it reads exactly like proof.

Re-run over `http://localhost` — a secure context — with the flag the Chromium binary actually carries:

```
baseline (no flags)                    -> { onDocument: "undefined", onNavigator: "undefined" }
--enable-features=WebMCP               -> { onDocument: "object",    onNavigator: "object"    }
```

**A native registry is reachable, and has been the whole time.** `tests/e2e/native-registry/` runs
against it — eight cases across two files, opt-in via `pnpm test:e2e:native`, measured on **Chromium
151.0.7922.34**.

| Question | Answered against the implementation |
|---|---|
| Duplicate name | **REJECTS** with `InvalidStateError` — the draft's behaviour, not the package's throw |
| `executeTool` input | **JSON string**; an object is refused — the package agrees, the draft does not |
| `execute`'s 2nd argument | **absent**; neither implementation supplies the draft's `AbortSignal` |
| `outputSchema` | **dropped** at registration and absent from the listing |
| Annotations | narrowed to the draft's **two**; the other three are dropped |
| Enumeration across a same-origin iframe | **yes** — a child document's tool appears in the parent's `getTools()` |
| `exposedTo` / `fromOrigins` | **both implemented and both required**, on top of a Permissions Policy gate defaulting to `'self'`. A tool exposed to an origin is returned to a parent that asks for that origin; omit either option and it is not |

**Cross-origin exposure, which took three attempts and is the most useful entry here.** Chromium
implements it fully, behind **three** gates that must all open:

```
Permissions Policy   feature `tools`, default allowlist 'self'  — the embedder must delegate with allow=
exposedTo            declared by the document registering the tool
fromOrigins          declared by the document enumerating
```

A tool that registers with `exposedTo` IS returned to a parent asking with `fromOrigins`; one that omits
either is not. **So the [cross-origin non-goal](design.md#non-goals) rests on three independent things,
and this library owns
exactly one of them** — it passes neither option. That guard is a lock on a live door.

The two conclusions this replaced were both unsupported, and each looked settled:

| Concluded | Why it was worthless |
|---|---|
| "both options are accepted, so the doors are open" | An **invented** option name is accepted too — WebIDL ignores unknown dictionary members. It measured tolerance, not implementation |
| "no cross-origin tool ever appears, so neither is implemented" | The frames were refused by the policy gate and never registered. The experiment had not run |

The delegation failed because the feature name was **guessed** from the host property. The
specification's Permissions Policy section says `tools`, and `src/webmcp/registry.ts` has spelled it
correctly since 2026-08-22, when the registry boundary was first written — **the answer was in this
repository's own source.** A wrong policy name
fails closed, which presents exactly as a feature being absent.

**What is still not evidenced.** Firefox and WebKit implement none of this, so the portability shim
remains the only path there and the three-engine matrix still runs the shim. And this is one build of
one engine tracking a moving draft: the lane is deliberately OUTSIDE the release gate, because a gate
that can go red because a browser shipped is a gate somebody switches off.

**The lesson, which outlives every fact above.** Three sentences were carried across three revisions — no
engine ships one; an engine ships one but it is gated; it is gated behind an origin trial — and each
was more precise than the last while all three were false. The thing that settled it was not more
careful wording. It was `strings` on the browser binary and a probe on a real origin.

That distinction is the same one [the browser-support page](browser-support.md#what-that-does-not-evidence)
makes about the browser matrix, and it is stated here rather than left for a reader to infer. The
first record of this question, from 2026-08-22, took the pessimistic version — that the rows might be
untestable — and it conflated two questions: the implementation cannot be tested, the reliance
can.

**Three things were written here as unknown, and all three were then measured.** They are kept, struck
through, because what they got wrong is more instructive than what they got right:

- ~~Whether the R5 divergences matter in practice is unknown.~~ Two of the three were already
  answerable from this repository's own code — annotations are inert because the boundary does not
  expose them, and the callback's second argument is inert because nothing reads it. Recording them as
  "unknown" **overstated the uncertainty** and hid the one that genuinely needed an engine.
- ~~Whether a native registry rejects a duplicate rather than throwing is unverified.~~ It rejects,
  with `InvalidStateError`. The stub agreed with the specification and so did the engine.
- ~~Whether `getTools()` really returns a same-origin iframe's tools is unverified.~~ It does.

**The predictions were written down so they could be wrong out loud** — that is the principle this
repository follows with every unknown it records — and one of them was: the
`executeTool` row predicted that this repository's conformance case would fail against a native
registry. It passes. The draft is the outlier there, not the package.

**What that leaves genuinely unknown** is narrower and worth stating on its own: whether Firefox and
WebKit will agree when they implement this, and whether Chromium's behaviour tracks the draft as both
move. Neither is answerable by being more careful with words.

**The open React row.** React ≥ 18 is declared as a peer range and only 19.2 is installed and tested.
Answering it needs a second React in the workspace, which is a toolchain change with its own
consequences. The design names this row among the open ones rather than letting an owed case read as a
passed one (see [testing strategy](design.md#testing-strategy)) — so the row is listed and unticked.
**An open row is the honest state; an absent one is a claim nobody is checking.**

## Why these are not ordinary unit tests

`tests/unit/webmcp/` tests **this library's boundary** against a stub registry whose behaviour this
repository chose. That is the right instrument for asking how the boundary classifies a refusal.

These cases do the opposite: they initialize the **real** portability layer and assert what it does.
The duplicate-name row shows why both are needed — `classifyRegistrationFailure` only runs if something
throws, so a registry that silently accepted a duplicate would leave two tools under one name with
nothing raised, and the library would be classifying an event that never happens.

## Adding a row

A new reliance on adopted behaviour adds a row. Concretely:

1. Add the case to `tests/conformance/`, or to the layer that owns the mechanism if it needs a browser.
2. Add the row to the table above.
3. If it cannot be evidenced yet, add it **unticked with the reason** rather than leaving it out.

A conformance failure blocks a release. The design's rule, from
[testing strategy](design.md#testing-strategy): *"no requirement is claimed against such a behaviour
before its case passes."* A layer whose failure was advisory would record that a dependency
bump broke something and let the release proceed anyway.

### Re-checking for a native registry — and the part that makes the check work

Rows here stay unticked when nothing evidences them. For anything needing a real native registry, the
lane already exists — `pnpm test:e2e:native`. What follows is how the reachability itself was
established, kept because the same question will arise for Firefox and WebKit:

```js
// tests/e2e/, inside page.addInitScript — NOT inside a test body.
page.addInitScript(() => {
  (globalThis as { __nativeAtLoad?: unknown }).__nativeAtLoad = {
    onDocument: typeof (document as { modelContext?: unknown }).modelContext,
    onNavigator: typeof (navigator as { modelContext?: unknown }).modelContext,
  };
});
```

**Two traps, and this repository fell into both.** They are opposites, which is why naming only one is
not enough:

1. **The probe must run at document load**, before the application's bundle evaluates. The portability
   layer installs a registry at the canonical location, so `page.evaluate(() => !!document.modelContext)`
   inside a test returns `true` **on every engine, forever** — reporting this library's own shim as an
   implementation. A probe that can only ever say yes.
2. **The page must be served over a secure context** — `http://localhost` or `https:`, never a `data:`
   URL. The interface is `[SecureContext]`, and a `data:` URL is an opaque origin, so the probe returns
   `undefined` **on every engine with every flag** — reporting a present implementation as absent. A
   probe that can only ever say no.

The conformance review of 2026-08-28 wrote the first warning and then walked into the second,
concluding from a `data:` URL that Chromium 151 exposed nothing. It exposes a registry under
`--enable-features=WebMCP`; the flag names live in the browser binary (`strings … | grep -i webmcp`
surfaces `enable-webmcp-testing` and the feature name) rather than in any document this project can
pin.

An engine reporting a type other than `"undefined"` has a native registry. Add its cases to
`tests/e2e/native-registry/`, which is opt-in and outside the release gate for the reason recorded
there.
