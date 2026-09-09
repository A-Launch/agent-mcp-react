// Level 2 — semantic DOM control, the READ half. The fallback's contract is `docs/dom-inspection.md`;
// the redaction and never-registered rules it lives under are `docs/design.md#security-invariants`.
//
// What an agent gains here: when a flow was never instrumented with a Level 1 tool, it can ask what is
// on screen — roles and accessible names — and read the text of one thing it was shown. It cannot
// touch anything through the read half; writing sits behind the other half of the same capability.
//
// **This is a fallback and a regression signal, not a feature to grow.** The three levels of control
// are separate layers (`docs/design.md#three-levels-of-control`), and a DOM tool for a flow that
// already HAS an application tool is a regression, not a convenience. Reaching for `dom.snapshot`
// where a Level 1 tool would do means a flow needs instrumenting.
//
// **What this directory owns:** the serializer, the reference table and its epoch, the witness that
// makes a recycled node refuse, and redaction. Nothing else.
//
// **What it does NOT own, each for a reason that outlives this comment:**
//
//   - **The capability gate.** It lives in the runtime, because a module that decides whether it may
//     run is a module that can be imported past its own check.
//   - **Registration.** These tools are NEVER registered. They are a closed build-time set reached
//     only across this library's bridge, and they MUST NOT be placed in the document's shared tool
//     registry in any configuration — including one that granted `dom.inspect` — which is invariant 16
//     in `docs/design.md#security-invariants`. Anything in that registry is callable by every script on
//     the page with not one gate in the path.
//   - **React.** Not imported here, and a seam case enforces it.
//   - **The socket.** Never referenced here.
//   - **A validator.** `dom.get_text` declares an input schema, so the factory below takes the
//     compiled validator from its caller — exactly as an application's tool does.
//
// **Its own subpath export** (`@agent-mcp/react/dom`), so a build that never imports it never contains
// it — the levels of control are separate layers, and one confers nothing on another. That is why the
// provider does not import this module: an application opts in by importing, and an operator opts in
// by granting, and neither implies the other.

export { NOT_INTERACTABLE, type NotInteractable } from './interact.ts';
export {
  PRESSABLE_KEY,
  type PressableKey,
  SCROLL_DIRECTION,
  type ScrollDirection,
} from './keys.ts';
export { invalidateDomRefs } from './references.ts';
export type { SemanticElement, Snapshot } from './snapshot.ts';
export { domInspectTools, domInteractTools } from './tools.ts';
