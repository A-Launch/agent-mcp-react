// Whether a person can perceive an element.
//
// **Invariant this file enforces: no layout is ever read.** Not `offsetParent`, not
// `getClientRects()`, not `checkVisibility()`, not `getBoundingClientRect()`. That is a hard rule
// rather than a preference, and it was established by measurement rather than reasoning
// (research R2):
//
//   - `checkVisibility()` does not exist in jsdom at all.
//   - `offsetParent` is `null` and `getClientRects()` is empty for EVERY element there, including a
//     plainly visible button. An implementation using either returns an empty snapshot in the
//     environment most of this repository's cases run in — while looking correct in a browser, so the
//     cases above it would be green against a serializer that returns nothing.
//
// **And the ancestor walk below is not a jsdom workaround — it is the correct implementation
// everywhere.** `display` is not an inherited property, so `getComputedStyle` on a button inside a
// `display:none` div reports the button's own `inline-block`, in jsdom AND in a real browser: the
// computed value is not the used value. Anyone reaching for a "proper" API here to replace this walk
// is about to reintroduce the empty snapshot.
//
// **What this deliberately does not decide**, stated because it reads as a gap and is a boundary: an
// element that is zero-sized, clipped, or covered by an overlay IS perceivable here. This reports what
// the page declares. Whether an element can actually be reached is a fact you learn when you try to
// touch it — the write tools decide that, at the point of use.

/** How far up the tree the walk goes before giving up. A page nested deeper than this is pathological. */
const MAX_DEPTH = 100;

/**
 * Whether an element is perceivable, from the declarative ways of hiding something.
 *
 * Five conditions, checked on the element and on every ancestor up to the document:
 * `display: none`, `visibility: hidden`, the `hidden` attribute, `aria-hidden="true"`, `inert`.
 *
 * A detached element is never perceivable — nobody can see something that is not in the document, and
 * treating it as visible would let a snapshot describe a page that is not on screen.
 */
export function isPerceivable(element: Element): boolean {
  if (!element.isConnected) return false;

  // An input that carries no information a person can see. Refused here as well as by having no role
  // in `roles.ts` — TWO independent reasons, which is what stops one refactor removing both. Invariant:
  // a hidden input's value is never exposed (invariant 13 in `docs/design.md#security-invariants`).
  if (element.tagName === 'INPUT') {
    const type = element.getAttribute('type')?.trim().toLowerCase();
    if (type === 'hidden') return false;
  }

  const view = element.ownerDocument.defaultView;
  let node: Element | null = element;
  let depth = 0;

  while (node !== null && depth < MAX_DEPTH) {
    // A VALUE comparison, never a presence check: `aria-hidden="false"` is an author deliberately
    // saying the opposite, and `hasAttribute` would read it as agreement.
    if (node.getAttribute('aria-hidden') === 'true') return false;
    if (node.hasAttribute('hidden')) return false;
    if (node.hasAttribute('inert')) return false;

    if (view !== null) {
      const style = view.getComputedStyle(node);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }

    node = node.parentElement;
    depth += 1;
  }

  return true;
}
