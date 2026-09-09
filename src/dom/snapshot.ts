import { accessibleNameOf } from './naming.ts';
import { isPerceivable } from './perceivable.ts';
import { beginTable } from './references.ts';
import { namesFromContent, roleOf, SNAPSHOT_ROLE, type SnapshotRole } from './roles.ts';

// The ONE serializer: a semantic picture of the document, and the one place a value is ever read.
//
// **Invariant: attributes are never traversed**, so no sensitive value and no token is ever included
// automatically (invariants 11 and 14 in `docs/design.md#security-invariants`). Not walked and
// filtered against a deny-list — not walked at all. A serializer that walked attributes and removed
// the sensitive ones leaks the first attribute nobody thought of; one that reads only the fields the
// projection below names cannot. Absence by construction rather than by filter: fix the mechanism
// that produces a class of leaks, not one leak.
//
// **Invariant: there is exactly ONE function that turns an element into a value**, and it asks what
// kind of element it is before it asks for anything. `platform-gotchas` pre-judged the alternative:
// *"If it is implemented in the snapshot serializer's 'verbose' branch only, it will come back the
// first time someone adds a second serializer."* There is no second serializer and no verbose branch.
// `dom.get_text` does not call `controlValueOf` at all, which is why the password guarantee holds structurally
// rather than through a parallel check that could drift.
//
// **Invariant: no markup, ever** (`docs/dom-inspection.md#what-never-reaches-the-agent`). No tag name,
// no attribute name, no `innerHTML`, no `outerHTML`, no page source in any field. `dom.snapshot`
// returning page HTML is the failure the DOM fallback's design exists to forbid, and it arrives
// disguised as convenience.

/**
 * The most elements a snapshot returns.
 *
 * 500 is the performance budget's own number — *"a tool registry containing 500 tools MUST remain
 * functional"* (`docs/records/performance-budgets.md#capacity-and-timing`) — reused rather than
 * invented, so the bound has an owner in the design instead of being a constant nobody chose.
 *
 * **A build constant and not an argument.** A limit an agent can raise is not a bound on the page.
 */
export const SNAPSHOT_ELEMENT_LIMIT = 500;

/** One element as the agent sees it. A PROJECTION: nothing is present that this shape does not name. */
export interface SemanticElement {
  readonly ref: string;
  readonly role: SnapshotRole;
  /** Absent when no source yields one. **Never fabricated** — see `naming.ts`. */
  readonly name?: string;
  /** Present only where the value is part of what the control means. Never for a password. */
  readonly value?: string;
  /** Present only when true — a disabled control is a fact an agent cannot infer from silence. */
  readonly disabled?: true;
}

export interface Snapshot {
  readonly url: string;
  readonly title: string;
  readonly elements: readonly SemanticElement[];
  /**
   * How many elements were omitted. **Present only when non-zero.**
   *
   * A count and not a boolean: an agent told "there is more" can do nothing with it, and an agent told
   * "312 more" knows whether it is looking at a page or at a fragment of one.
   */
  readonly truncated?: number;
}

/**
 * The value of a control, or nothing — the ONE site that reads a value from the page.
 *
 * Invariant it enforces: **a password value and a hidden input's value never leave this page** —
 * redaction is unconditional, with no opt-out (invariants 12 and 13 in
 * `docs/design.md#security-invariants`). It asks the element what kind it is BEFORE asking it for
 * anything, so there is no ordering in which a value is read and then discarded — a read that happened
 * is a read that a future refactor can forward somewhere.
 *
 * A `<select>` reports the selected option's LABEL rather than its `value` attribute, because the
 * label is what a person sees and the agent is being told what is on screen.
 *
 * **Exported so its own guarantee can be tested, and that is not a testing convenience.** The hidden
 * branch here is UNREACHABLE through `takeSnapshot` today: a hidden input is refused twice before it
 * arrives, once for having no role in the vocabulary and once by `isPerceivable`. Found by running the
 * break-it — deleting this branch turned nothing red, which meant the comment claiming two independent
 * reasons was a claim nothing checked.
 *
 * The branch stays, because defence in depth here is cheap and the failure it guards is a token in an
 * agent's transcript. What changed is that it is now VERIFIED at the layer where it is reachable
 * instead of asserted at a layer where it is not. This repository has met the same shape before: the
 * ajv adapter's `verbose: false` and its message composition are two layers under one rule, and the
 * finding then was that a case which cannot tell which layer it is testing is a case that will go
 * green when the wrong one is deleted.
 */
export function controlValueOf(element: Element): string | undefined {
  if (element.tagName === 'INPUT') {
    const input = element as HTMLInputElement;
    const type = (element.getAttribute('type') ?? 'text').trim().toLowerCase();
    // Redaction, unconditional and with no opt-out: not a capability, not a build flag, not an
    // observability setting. The element itself is still reported, with its role and its name, because
    // an agent must be able to see that a password is being asked for.
    if (type === 'password' || type === 'hidden') return undefined;
    if (type === 'checkbox' || type === 'radio') return input.checked ? 'checked' : 'unchecked';
    return input.value === '' ? undefined : input.value;
  }
  if (element.tagName === 'TEXTAREA') {
    const value = (element as HTMLTextAreaElement).value;
    return value === '' ? undefined : value;
  }
  if (element.tagName === 'SELECT') {
    const select = element as HTMLSelectElement;
    const selected = select.selectedOptions[0];
    return selected === undefined ? undefined : (selected.textContent ?? undefined);
  }
  return undefined;
}

/** Whether a control reports itself unavailable. `aria-disabled` is a value, never a presence check. */
function isDisabled(element: Element): boolean {
  if (element.getAttribute('aria-disabled') === 'true') return true;
  return element.hasAttribute('disabled');
}

/**
 * Reads the document once and returns what is on screen, minting a fresh reference table as it goes.
 *
 * The table is installed WHOLE at the end: a pass that threw partway must not leave a half-populated
 * table live, which would hand an agent references to a page state nobody described.
 *
 * **No work happens unless this is called** (`docs/dom-inspection.md#cost`). Nothing observes, nothing
 * polls, nothing listens.
 */
export function takeSnapshot(document: Document): Snapshot {
  const table = beginTable(document);
  const elements: SemanticElement[] = [];
  let omitted = 0;

  // `*` and then a role test, rather than a selector listing the admitted tags. The role vocabulary is
  // the one owner of what counts as semantic, and a closed set is spelled once; a selector here would
  // be a second spelling of that set, and the two would drift the first time a role was added.
  for (const element of document.body?.querySelectorAll('*') ?? []) {
    const role = roleOf(element);
    if (role === undefined) continue;
    if (!isPerceivable(element)) continue;

    if (elements.length >= SNAPSHOT_ELEMENT_LIMIT) {
      omitted += 1;
      continue;
    }

    const name = accessibleNameOf(element, namesFromContent(role));
    const value = controlValueOf(element);
    const ref = table.mint(element, role, name);
    elements.push({
      ref,
      role,
      // Conditional spread rather than an unconditional key: an optional field present and `undefined`
      // is not the same as absent, and the protocol layer serializes the former.
      ...(name === undefined ? {} : { name }),
      ...(value === undefined ? {} : { value }),
      ...(isDisabled(element) ? { disabled: true as const } : {}),
    });
  }

  table.commit();

  return {
    url: document.defaultView?.location.href ?? '',
    title: document.title,
    elements,
    ...(omitted === 0 ? {} : { truncated: omitted }),
  };
}

/**
 * The text of one element.
 *
 * **Never reads `value`** — not by checking and skipping it, but by not having a path to it. That is
 * why a password's value cannot arrive through this route: an input's value is not its text
 * content, so there is nothing here to redact.
 */
export function textOf(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Roles whose value is meaningful, exported so a case can assert the projection rather than infer it. */
export const VALUE_BEARING_ROLES: readonly SnapshotRole[] = [
  SNAPSHOT_ROLE.textbox,
  SNAPSHOT_ROLE.searchbox,
  SNAPSHOT_ROLE.checkbox,
  SNAPSHOT_ROLE.radio,
  SNAPSHOT_ROLE.combobox,
  SNAPSHOT_ROLE.spinbutton,
  SNAPSHOT_ROLE.slider,
];
