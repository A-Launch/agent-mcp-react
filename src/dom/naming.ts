// The accessible name an element reports, in a declared precedence order.
//
// **This is an APPROXIMATION and not the accname algorithm, and saying so is part of the deliverable.**
// A complete implementation of accname has its own recursion, CSS pseudo-content and traversal rules;
// writing one is a second product inside this feature, and taking a dependency for it is a scope
// decision nobody has ordered. The six sources below cover what a real application produces.
//
// **What is deliberately NOT done: fabricating a name from surrounding text when none of the six
// yields one.** An element with no accessible name is a real defect on a real page, and an agent given
// a plausible name for it will report success against a control a screen-reader user cannot find. The
// snapshot reports the role with no name and the honest gap stays visible — an unexpected state fails
// loud, never hides behind a convenience default.
//
// A VOCABULARY-adjacent reader: it looks at the document and decides nothing about access.

/** How long a name may be before it is a paragraph rather than a name. */
const NAME_LIMIT = 200;

/**
 * Collapses whitespace and bounds the length, so a name is something an agent can match on.
 *
 * The bound is not a redaction — it is what stops one `<button>` wrapping a page of text from
 * consuming the snapshot's budget. Nothing sensitive is protected by it and nothing should rely on it
 * as though it were — keeping a sensitive value out of the agent's hands is the value site's job, not
 * this one's (`docs/reference-capabilities.md#what-the-library-redacts-and-what-it-does-not`).
 */
function clean(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return undefined;
  return collapsed.length > NAME_LIMIT ? `${collapsed.slice(0, NAME_LIMIT)}…` : collapsed;
}

/**
 * The accessible name, or nothing.
 *
 * Precedence, highest first — the order assistive technology uses, so what an agent is told matches
 * what a person is told:
 *
 *   1. `aria-labelledby`, resolved against the document.
 *   2. `aria-label`.
 *   3. An associated `<label>`, through the platform's own `labels` collection.
 *   4. `alt`.
 *   5. `title`.
 *   6. The element's own text — **only when the role permits it** (`nameFromContent`). A container's
 *      text content is everything inside it, so a landmark named that way reports a blob of the whole
 *      page. Found in a live browser; see `namesFromContent` in `roles.ts` for the set and its one
 *      deliberate addition.
 *
 * **Source 6 never reads a password's value**, because it reads `textContent`, and an input's value is
 * not its text content. That is a structural property rather than a check — which is why `dom.get_text`
 * can share this reasoning and never call the value site at all.
 */
export function accessibleNameOf(element: Element, nameFromContent = true): string | undefined {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    const parts: string[] = [];
    for (const id of labelledBy.split(/\s+/)) {
      if (id === '') continue;
      const referenced = element.ownerDocument.getElementById(id);
      if (referenced !== null) parts.push(referenced.textContent ?? '');
    }
    const joined = clean(parts.join(' '));
    // A dangling `aria-labelledby` falls THROUGH to the next source rather than yielding an empty
    // name. An author who mistyped an id has an element with a label they cannot see; giving it no
    // name at all would hide a second, real source underneath.
    if (joined !== undefined) return joined;
  }

  const label = clean(element.getAttribute('aria-label'));
  if (label !== undefined) return label;

  // The platform's own association: `for=`, and ancestor wrapping, without re-deriving either.
  const labels = (element as Partial<HTMLInputElement>).labels;
  if (labels !== undefined && labels !== null && labels.length > 0) {
    const fromLabels = clean(Array.from(labels, (one) => one.textContent ?? '').join(' '));
    if (fromLabels !== undefined) return fromLabels;
  }

  const alt = clean(element.getAttribute('alt'));
  if (alt !== undefined) return alt;

  const title = clean(element.getAttribute('title'));
  if (title !== undefined) return title;

  // Source 6, and the only one that depends on WHAT the element is rather than what it declares.
  return nameFromContent ? clean(element.textContent) : undefined;
}
