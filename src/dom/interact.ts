import { SCROLL_DIRECTION, type ScrollDirection } from './keys.ts';
import { isPerceivable } from './perceivable.ts';

// Acting on one element the agent was shown: whether it may be operated, and how the operation is
// applied so the application actually receives it.
//
// **Two invariants, and both exist because something measured behaves differently from how it reads.**
//
// **1. Interactability is decided HERE, before anything is dispatched, because the platform is
// unreliable in both directions.** Measured, React 19, jsdom:
//
//     disabled              a programmatic .click() is REFUSED by the platform
//     inert ancestor        a programmatic .click() goes THROUGH
//     pointer-events: none  a programmatic .click() goes THROUGH
//
// A synthetic click dispatches an event and skips hit-testing entirely. So an unchecked click reports
// success for a call that did nothing (disabled), AND performs an action no person at the same page
// could perform (inert, pointer-events). Neither direction is acceptable and the platform fixes
// neither.
//
// **2. A value is written through the element's NATIVE prototype setter, never by assignment.**
// Measured on a controlled React input: `element.value = x` followed by an `input` event leaves the
// DOM showing the value and React's state EMPTY. React tracks the last value it wrote on the node and
// assigning `.value` updates that tracker as a side effect, so React concludes nothing changed and
// skips the handler. The DOM is then overwritten on the next render — so the agent is told the field
// was filled, a person watches the value appear and vanish, and the application never had it.
//
// This reads a property descriptor off the element's own prototype, which is a PLATFORM API. Nothing
// here touches `__reactFiber`, `__reactProps` or React's tracker object — no React internals, ever
// (`docs/design.md#no-react-internals`) — and the cases pin the observable result rather than the
// mechanism.
//
// **No layout is read.** Not `offsetParent`, not `getClientRects`, not `elementFromPoint`. An element
// that is zero-sized, clipped, or covered by an overlay IS interactable here, and that limit is
// documented rather than hidden: layout is unreadable in the environment most of this repository's
// cases run in, so a check for it would pass vacuously in the suites while looking correct in a
// browser.
//
// **No capability check lives here.** That is the runtime's, because a module that decides whether it
// may run is a module that can be imported past its own check.

/** Why an element cannot be operated. A closed set, declared once and never re-spelled elsewhere. */
export const NOT_INTERACTABLE = {
  /** A person cannot see it — `isPerceivable`'s ancestor walk. */
  notPerceivable: 'notPerceivable',
  /** The platform's own unavailability. It silently swallows the event. */
  disabled: 'disabled',
  /** The author's declared unavailability, which the platform does NOT enforce. */
  ariaDisabled: 'ariaDisabled',
  /** Inside an `inert` subtree — which a synthetic click would otherwise walk straight into. */
  inert: 'inert',
  /** Unreachable by pointer, which a synthetic click also bypasses. */
  pointerEventsNone: 'pointerEventsNone',
  /** A field that cannot be typed into. `dom.fill` only. */
  readOnly: 'readOnly',
  /** The element does not hold a typed value, so filling it would write somewhere nothing reads. */
  notAField: 'notAField',
  /** No native setter for this element's value — refused rather than fallen back to assignment. */
  noNativeSetter: 'noNativeSetter',
} as const;

export type NotInteractable = (typeof NOT_INTERACTABLE)[keyof typeof NOT_INTERACTABLE];

/** Operable, or refused with a named cause. Never a boolean: the cause is what an operator acts on. */
export type Interactability =
  | { readonly operable: true }
  | { readonly operable: false; readonly because: NotInteractable };

const OPERABLE: Interactability = { operable: true };

function refuse(because: NotInteractable): Interactability {
  return { operable: false, because };
}

/** How far up the tree the ancestor checks walk. Matches `perceivable.ts`. */
const MAX_DEPTH = 100;

/**
 * Whether this element may be operated at all.
 *
 * Checked in cheapest-first order so the reported cause is deterministic rather than a race between
 * conditions that would each refuse.
 */
export function interactabilityOf(element: Element): Interactability {
  // **The specific causes are checked BEFORE the general one, and that ordering was a finding.**
  // `isPerceivable` already treats `inert` as hiding — correctly, since inert content is removed from
  // the accessibility tree — so with perceivability first, the `inert` cause could never fire. An
  // unreachable member of a closed cause set is the same unverifiable-claim shape `controlValueOf` in
  // `snapshot.ts` records finding in its own redaction guard, and the fix is the same: make it
  // reachable rather than leave it as decoration.
  //
  // It is also the better answer for an operator. "This is inert" and "this is disabled" each say what
  // to change; "not perceivable" is the residual cause, not the headline one.
  const view = element.ownerDocument.defaultView;
  let node: Element | null = element;
  let depth = 0;

  while (node !== null && depth < MAX_DEPTH) {
    // A VALUE comparison, never a presence check: `aria-disabled="false"` is an author saying the
    // opposite, and `hasAttribute` would read it as agreement.
    if (node.getAttribute('aria-disabled') === 'true') {
      return refuse(NOT_INTERACTABLE.ariaDisabled);
    }
    if (node.hasAttribute('inert')) return refuse(NOT_INTERACTABLE.inert);
    node = node.parentElement;
    depth += 1;
  }

  // The platform's own flag. Refused although the platform would also refuse it, because the platform
  // refuses it SILENTLY — the click is swallowed and the tool would report success for nothing.
  if ((element as Partial<HTMLButtonElement>).disabled === true) {
    return refuse(NOT_INTERACTABLE.disabled);
  }

  if (view !== null && view.getComputedStyle(element).pointerEvents === 'none') {
    return refuse(NOT_INTERACTABLE.pointerEventsNone);
  }

  // The general case, last: hidden by `display`, `visibility`, `hidden` or `aria-hidden` — the reasons
  // that are not more specifically one of the above.
  if (!isPerceivable(element)) return refuse(NOT_INTERACTABLE.notPerceivable);

  return OPERABLE;
}

/** The elements `dom.fill` accepts: the ones that hold a typed value, and nothing else. */
const FILLABLE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'email',
  'tel',
  'url',
  'number',
  'password',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
]);

/**
 * Whether `dom.fill` may write to this element.
 *
 * A `<select>` is `dom.select`'s and a `contenteditable` is a rich-text surface whose value is not a
 * string — both are refused rather than filled into a property nothing reads, which is R1's silent
 * failure wearing a different hat.
 */
export function fillabilityOf(element: Element): Interactability {
  const base = interactabilityOf(element);
  if (!base.operable) return base;

  if (element.tagName === 'TEXTAREA') {
    return (element as HTMLTextAreaElement).readOnly ? refuse(NOT_INTERACTABLE.readOnly) : OPERABLE;
  }
  if (element.tagName !== 'INPUT') return refuse(NOT_INTERACTABLE.notAField);

  const input = element as HTMLInputElement;
  const type = (element.getAttribute('type') ?? 'text').trim().toLowerCase();
  if (!FILLABLE_INPUT_TYPES.has(type)) return refuse(NOT_INTERACTABLE.notAField);
  return input.readOnly ? refuse(NOT_INTERACTABLE.readOnly) : OPERABLE;
}

/**
 * Writes a property through the element's OWN prototype setter.
 *
 * Invariant: **never by assignment.** Assigning updates React's value tracker as a side effect, so
 * React concludes nothing changed and the application's handler never runs — measured, and it is the
 * defect that reports success at every step.
 *
 * Walks the prototype chain rather than naming `HTMLInputElement`, because a `<textarea>` and a
 * `<select>` each own their own `value` setter. Returns whether it found one; the caller REFUSES when
 * it did not, rather than falling back to assignment — a fallback here cannot be told from success.
 */
function setThroughNativeSetter(element: Element, property: string, value: string): boolean {
  let proto: object | null = Object.getPrototypeOf(element);
  while (proto !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, property);
    if (descriptor?.set !== undefined) {
      descriptor.set.call(element, value);
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/** Dispatches an event the way the platform would — bubbling, so a delegated handler receives it. */
function fire(element: Element, type: string): void {
  element.dispatchEvent(new Event(type, { bubbles: true }));
}

/**
 * Sets a field's value so the application receives it.
 *
 * Native setter, then `input` and `change` — the pair a person's own typing produces. Both are
 * dispatched because a controlled React input listens for `input` while a plain form listener may
 * only listen for `change`, and an interaction that worked for one shape and not the other would be a
 * tool that works on some pages.
 */
export function applyFill(element: Element, value: string): Interactability {
  if (!setThroughNativeSetter(element, 'value', value)) {
    return refuse(NOT_INTERACTABLE.noNativeSetter);
  }
  fire(element, 'input');
  fire(element, 'change');
  return OPERABLE;
}

/**
 * Chooses an option in a `<select>` by the LABEL the snapshot reported.
 *
 * By label rather than by `value`, because the label is what the agent was told and the `value`
 * attribute is markup it never saw.
 */
export function applySelect(element: Element, label: string): Interactability {
  if (element.tagName !== 'SELECT') return refuse(NOT_INTERACTABLE.notAField);
  const select = element as HTMLSelectElement;
  const match = Array.from(select.options).find(
    (option) => (option.textContent ?? '').trim() === label.trim(),
  );
  if (match === undefined) return refuse(NOT_INTERACTABLE.notAField);
  if (!setThroughNativeSetter(element, 'value', match.value)) {
    return refuse(NOT_INTERACTABLE.noNativeSetter);
  }
  fire(element, 'input');
  fire(element, 'change');
  return OPERABLE;
}

/** Presses one key at the element, as a person's keyboard would: down, then up, both bubbling. */
export function applyPress(element: Element, key: string): void {
  const target = element as HTMLElement;
  if (typeof target.focus === 'function') target.focus();
  for (const type of ['keydown', 'keyup']) {
    element.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
  }
}

/** How far one `up`/`down` step moves, when the element does not report a useful height. */
const SCROLL_STEP = 400;

/**
 * Scrolls the element a reference names, or its nearest scrollable ancestor.
 *
 * Reports where it ended up rather than promising it moved: a page that cannot scroll returns its
 * unchanged position, which is the true answer rather than a failure: the state is reported as it is,
 * never replaced by a convenience default.
 */
export function applyScroll(element: Element, direction: ScrollDirection): { top: number } {
  let target: Element | null = element;
  let depth = 0;
  while (target !== null && depth < MAX_DEPTH) {
    if (target.scrollHeight > target.clientHeight) break;
    target = target.parentElement;
    depth += 1;
  }
  const scroller = target ?? element.ownerDocument.documentElement;
  const step = scroller.clientHeight > 0 ? scroller.clientHeight : SCROLL_STEP;

  if (direction === SCROLL_DIRECTION.top) scroller.scrollTop = 0;
  else if (direction === SCROLL_DIRECTION.bottom) scroller.scrollTop = scroller.scrollHeight;
  else if (direction === SCROLL_DIRECTION.up) scroller.scrollTop -= step;
  else scroller.scrollTop += step;

  return { top: scroller.scrollTop };
}
