import { accessibleNameOf } from './naming.ts';
import { namesFromContent, roleOf, type SnapshotRole } from './roles.ts';

// The reference table, the epoch, and the five conditions a reference must satisfy to resolve.
//
// **This is the only file in `src/dom/` that holds state, and it holds exactly one table.** An older
// table is not kept, not weakly held and not consulted: its tokens are below the current epoch and are
// refused from the counter alone, which is what makes "one live table" cost nothing to enforce.
//
// **Nothing here observes the document.** The design forbids it — *no DOM scanning unless
// `dom.snapshot` is requested* (`docs/dom-inspection.md#cost`) — so there is no `MutationObserver`, no
// navigation listener and above all no patched `history.pushState`, which would be a global mutation
// of a platform API by an embedded library and the browser-automation posture the non-goals
// (`docs/design.md#non-goals`) rule out. Every condition below is a COMPARISON made at the moment a
// reference is used. An event can be missed and the failure is silent; a comparison cannot be missed —
// an unexpected state fails loud here rather than becoming a hidden unknown.
//
// **The fifth condition is not among the staleness triggers the DOM fallback's design names, and it is
// the one that matters most** (`docs/dom-inspection.md#references-go-stale-and-that-is-the-feature`).
// Measured in this repository
// (research R1): React reuses a row's DOM node across a data change, so after a filter the same
// `<button>` that said "Acme" says "Zenith" — the SAME OBJECT, still connected, at an unchanged URL,
// in a list whose length changed. Conditions 1, 2 and 3 all pass for it. What refuses it is the
// witness: the role and accessible name the snapshot PUBLISHED to the agent, re-checked at use.
//
// **What the witness cannot catch, stated here rather than discovered later:** two elements with the
// same role and the same accessible name are indistinguishable to it. A column of identical "Open"
// buttons is exactly that case. That residue is why `invalidateDomRefs()` exists, why Level 2 is a
// fallback, and why it ships experimental.

/**
 * Where the counter and the live table live.
 *
 * `Symbol.for` rather than a module-scope variable, for the reason `page-identity.ts` and
 * `webmcp/claim.ts` both record: a separately bundled second copy of this library computes the same
 * symbol from the same string and therefore shares this state. Two copies with private counters would
 * mint colliding tokens for one document — and a token that means two elements is precisely the
 * failure the never-reuse rule exists to make unreachable.
 */
const STATE_KEY = Symbol.for('agent-mcp-react.dom-reference-state');

/** What one reference remembers, beyond the element itself. */
export interface ReferenceWitness {
  readonly element: Element;
  /**
   * The role and name the snapshot PUBLISHED — what the agent was TOLD, not what the element is.
   *
   * That phrasing is the design: "this element no longer matches what you were told" is then literally
   * true, and a refusal means something an agent can act on. A hash of the subtree would refuse a row
   * because an unrelated sibling column re-rendered — a refusal with no action behind it, which trains
   * an agent to re-snapshot constantly.
   */
  readonly role: SnapshotRole;
  readonly name: string | undefined;
}

interface LiveTable {
  readonly epoch: number;
  /** `location.href` when this table was minted — the navigation comparison. */
  readonly url: string;
  readonly entries: ReadonlyMap<string, ReferenceWitness>;
}

interface ReferenceState {
  /** Monotonic, never decreasing. Serves BOTH "is this token current" and "was it ever issued". */
  counter: number;
  table: LiveTable | undefined;
}

/** Why a reference did not resolve. A closed set, declared once and never re-spelled elsewhere. */
export const REFERENCE_REFUSAL = {
  /**
   * This document never issued that token — invented, mistyped, or from another tab: each page
   * instance is its own identity (`docs/design.md#page-identity`) and mints its own references.
   */
  neverIssued: 'neverIssued',
  /** Issued, but a newer snapshot replaced the table it belonged to. */
  supersededBySnapshot: 'supersededBySnapshot',
  /** Its element has left the document. */
  elementRemoved: 'elementRemoved',
  /** The page navigated since the table was minted. */
  pageNavigated: 'pageNavigated',
  /** The element no longer matches the role and name the snapshot published for it. */
  elementRecycled: 'elementRecycled',
  /** The application invalidated every outstanding reference. */
  invalidatedByApplication: 'invalidatedByApplication',
} as const;

export type ReferenceRefusal = (typeof REFERENCE_REFUSAL)[keyof typeof REFERENCE_REFUSAL];

/**
 * Resolved, or refused with a named cause.
 *
 * A discriminated outcome rather than an element-or-`undefined`, and the difference is the whole point
 * of a named cause: `undefined` would collapse "never issued" into "expired" at the one place the
 * design separates them, and would leave the caller to reconstruct which condition failed.
 */
export type ReferenceOutcome =
  | { readonly resolved: true; readonly element: Element }
  | { readonly resolved: false; readonly because: ReferenceRefusal };

interface DocumentWithState extends Document {
  [STATE_KEY]?: ReferenceState;
}

function stateOf(document: Document): ReferenceState {
  const host = document as DocumentWithState;
  const existing = host[STATE_KEY];
  if (existing !== undefined) return existing;
  const created: ReferenceState = { counter: 0, table: undefined };
  Object.defineProperty(host, STATE_KEY, {
    value: created,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return created;
}

/** `e` followed by the ordinal. The ordinal is the whole of the token's meaning. */
function tokenFor(ordinal: number): string {
  return `e${ordinal}`;
}

/**
 * The ordinal a token names, or nothing when it is not a token this scheme could have minted.
 *
 * A strict parse. `banana`, `e`, `e-1`, `e1.5`, `e01` and `e 1` all yield nothing — a token is
 * untrusted agent input, and agent-provided data is never trusted, so it is parsed and bounded rather
 * than used to index anything directly. `e01` is rejected because this scheme never mints it, and
 * accepting a second spelling of one ordinal would make "was this issued" answerable two ways.
 */
function ordinalOf(token: string): number | undefined {
  const match = /^e([1-9][0-9]{0,15})$/.exec(token);
  if (match === null) return undefined;
  return Number(match[1]);
}

/**
 * Starts a new table, replacing whatever was live.
 *
 * Returns a minting function the snapshot calls per element, and a `commit` that installs the table.
 * Two steps rather than one because the table must be installed WHOLE: a snapshot that failed halfway
 * through must not leave a half-populated table live, which would hand the agent references to a page
 * state nobody described.
 */
export function beginTable(document: Document): {
  mint: (element: Element, role: SnapshotRole, name: string | undefined) => string;
  commit: () => void;
} {
  const state = stateOf(document);
  const entries = new Map<string, ReferenceWitness>();
  // Bumped here rather than at commit, so tokens minted during this pass belong to the epoch this
  // table will carry — and so a snapshot that throws still leaves every previously issued token
  // superseded rather than silently still valid.
  state.counter += 1;
  const epoch = state.counter;
  const url = document.defaultView?.location.href ?? '';

  return {
    mint(element, role, name) {
      state.counter += 1;
      const token = tokenFor(state.counter);
      entries.set(token, { element, role, name });
      return token;
    },
    commit() {
      state.table = { epoch, url, entries };
    },
  };
}

/**
 * Invalidates every outstanding reference — the staleness trigger the DOM fallback's design names but
 * gives no owner, here given one (`docs/dom-inspection.md#when-to-call-invalidatedomrefs`).
 *
 * The application calls this when the page changed in a way a snapshot cannot see: same URL, node
 * still connected, no new snapshot, and the row now shows a different record because a filter changed
 * in component state. **Only the application knows that**, which is why the trigger cannot belong to
 * this library alone — and why the witness above exists, so forgetting to call this refuses rather
 * than misleads.
 *
 * Needs no connection, is not reachable by the agent, and is safe when nothing is outstanding.
 */
export function invalidateDomRefs(document?: Document): void {
  const target = document ?? globalThis.document;
  // No document means a server render, where there are no references to invalidate. Silent because
  // nothing is wrong: an application calling this from isomorphic code is not making a mistake.
  if (target === undefined || target === null) return;
  const state = stateOf(target);
  state.counter += 1;
  state.table = undefined;
}

/**
 * Resolves a reference, or names which of the conditions refused it.
 *
 * **The order is cheapest-first, and it is what makes the reported cause deterministic** rather than a
 * race between checks that would each refuse. It is also the order a reader would want: "you invented
 * this token" before "your token expired" before "the thing it named changed".
 */
export function resolveReference(document: Document, token: string): ReferenceOutcome {
  const state = stateOf(document);

  const ordinal = ordinalOf(token);
  // 0 — never issued. Unparseable, or an ordinal beyond anything this document has minted.
  if (ordinal === undefined || ordinal > state.counter) {
    return { resolved: false, because: REFERENCE_REFUSAL.neverIssued };
  }

  const table = state.table;
  if (table === undefined) {
    // Issued at some point, and there is no live table — the application invalidated. Distinct from a
    // superseded token because an operator reading it is looking at their own call, not at an agent's
    // stale snapshot.
    return { resolved: false, because: REFERENCE_REFUSAL.invalidatedByApplication };
  }

  const witness = table.entries.get(token);
  // 1 — issued, and not from the live table. One comparison retires every token of every older table.
  if (witness === undefined) {
    return { resolved: false, because: REFERENCE_REFUSAL.supersededBySnapshot };
  }

  // 2 — the node left the document.
  if (!witness.element.isConnected) {
    return { resolved: false, because: REFERENCE_REFUSAL.elementRemoved };
  }

  // 3 — the page navigated, including a client-side route change that replaced no document. Derived,
  // never signalled: a `popstate` listener would miss `pushState`, which is how every router here
  // navigates.
  const url = document.defaultView?.location.href ?? '';
  if (url !== table.url) {
    return { resolved: false, because: REFERENCE_REFUSAL.pageNavigated };
  }

  // 4 — the witness. The condition the DOM fallback's design does not list, and the only one that
  // catches a node React has recycled into different data while it is still connected at an unchanged
  // URL (research R1).
  if (roleOf(witness.element) !== witness.role) {
    return { resolved: false, because: REFERENCE_REFUSAL.elementRecycled };
  }
  // Recomputed the SAME WAY the snapshot computed it, including the name-from-content rule. A
  // witness compared against a differently-derived name would refuse every container on the page.
  const currentRole = roleOf(witness.element);
  if (currentRole === undefined) {
    return { resolved: false, because: REFERENCE_REFUSAL.elementRecycled };
  }
  if (accessibleNameOf(witness.element, namesFromContent(currentRole)) !== witness.name) {
    return { resolved: false, because: REFERENCE_REFUSAL.elementRecycled };
  }

  return { resolved: true, element: witness.element };
}
