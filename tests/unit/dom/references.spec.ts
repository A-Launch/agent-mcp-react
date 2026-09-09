// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  invalidateDomRefs,
  REFERENCE_REFUSAL,
  resolveReference,
} from '../../../src/dom/references.ts';
import { takeSnapshot } from '../../../src/dom/snapshot.ts';

// The five conditions, and the boundary between the two failure codes.
//
// **Every case asserts WHICH condition decided, not only that one did.** Five conditions refuse a
// reference and four of them are cheap, so a case checking only "it was refused" passes for whichever
// check happens to fire first — and would stay green with the one it claims to test deleted. That is
// the failure mode this file is written against.

function html(markup: string): void {
  document.body.innerHTML = markup;
}

/** The ref the snapshot gave to the element with this accessible name. */
function refFor(name: string): string {
  const found = takeSnapshot(document).elements.find((one) => one.name === name);
  if (found === undefined) throw new Error(`no element named ${name} in the snapshot`);
  return found.ref;
}

beforeEach(() => {
  document.body.innerHTML = '';
  // Each case starts from a clean table. Not a reset of the counter — the counter is deliberately
  // monotonic for the life of the document, and a case that depended on it restarting would be
  // asserting the opposite of the never-reuse rule.
  invalidateDomRefs(document);
});

describe('a reference that resolves', () => {
  it('resolves to the element the snapshot described', () => {
    html('<button>Save</button>');
    const ref = refFor('Save');
    const outcome = resolveReference(document, ref);
    expect(outcome.resolved).toBe(true);
    expect(outcome.resolved && outcome.element.textContent).toBe('Save');
  });

  it('still resolves after a rerender that changed nothing about it', () => {
    html('<button>Save</button><span>unrelated</span>');
    const ref = refFor('Save');
    (document.querySelector('span') as Element).textContent = 'changed';
    expect(resolveReference(document, ref).resolved).toBe(true);
  });
});

describe('the five conditions, each named', () => {
  it('1 — a newer snapshot superseded it', () => {
    html('<button>Save</button>');
    const ref = refFor('Save');
    takeSnapshot(document);
    const outcome = resolveReference(document, ref);
    expect(outcome.resolved).toBe(false);
    expect(!outcome.resolved && outcome.because).toBe(REFERENCE_REFUSAL.supersededBySnapshot);
  });

  it('2 — its element left the document', () => {
    html('<button>Save</button>');
    const ref = refFor('Save');
    (document.querySelector('button') as Element).remove();
    const outcome = resolveReference(document, ref);
    expect(!outcome.resolved && outcome.because).toBe(REFERENCE_REFUSAL.elementRemoved);
  });

  it('3 — the page navigated, including a route change that replaced no document', () => {
    html('<button>Save</button>');
    const ref = refFor('Save');
    window.history.pushState({}, '', '/customers/42');
    const outcome = resolveReference(document, ref);
    expect(!outcome.resolved && outcome.because).toBe(REFERENCE_REFUSAL.pageNavigated);
    window.history.pushState({}, '', '/');
  });

  it('4 — the element was recycled into different content, while STILL CONNECTED at the SAME URL', () => {
    // **The staleness condition the DOM module's documented list does not name
    // (`docs/dom-inspection.md#references-go-stale-and-that-is-the-feature`), and the reason the
    // witness exists.** Measured in this
    // repository (research R1): React reuses a row's DOM node across a data change, so the same
    // `<button>` that said "Acme" says "Zenith" — same object, still in the document, same URL.
    //
    // The three assertions before the refusal are the point of the case. Without them it would pass
    // for a design that refused the reference for one of the other reasons, and those are exactly the
    // reasons a per-snapshot table would have got right while still handing back the wrong row.
    html('<button>Acme</button>');
    const ref = refFor('Acme');
    const node = document.querySelector('button') as Element;
    node.textContent = 'Zenith';

    expect(node.isConnected, 'the node is still in the document').toBe(true);
    expect(document.location.href, 'the URL has not changed').toBe(window.location.href);

    const outcome = resolveReference(document, ref);
    expect(!outcome.resolved && outcome.because).toBe(REFERENCE_REFUSAL.elementRecycled);
  });

  it('4b — a changed ROLE recycles it too, not only a changed name', () => {
    html('<div role="status">Working</div>');
    const ref = refFor('Working');
    (document.querySelector('[role]') as Element).setAttribute('role', 'alert');
    const outcome = resolveReference(document, ref);
    expect(!outcome.resolved && outcome.because).toBe(REFERENCE_REFUSAL.elementRecycled);
  });

  it('5 — the application invalidated references explicitly', () => {
    html('<button>Save</button>');
    const ref = refFor('Save');
    invalidateDomRefs(document);
    const outcome = resolveReference(document, ref);
    expect(!outcome.resolved && outcome.because).toBe(REFERENCE_REFUSAL.invalidatedByApplication);
  });
});

describe('the boundary between stale and never-issued', () => {
  it('calls an issued-but-expired token STALE, not unknown', () => {
    html('<button>Save</button>');
    const ref = refFor('Save');
    takeSnapshot(document);
    const outcome = resolveReference(document, ref);
    expect(!outcome.resolved && outcome.because).not.toBe(REFERENCE_REFUSAL.neverIssued);
  });

  it('calls a token beyond anything ever minted NEVER ISSUED', () => {
    html('<button>Save</button>');
    takeSnapshot(document);
    const outcome = resolveReference(document, 'e999999');
    expect(!outcome.resolved && outcome.because).toBe(REFERENCE_REFUSAL.neverIssued);
  });

  it('calls every malformed token NEVER ISSUED rather than guessing at it', () => {
    html('<button>Save</button>');
    takeSnapshot(document);
    for (const token of ['banana', '', 'e', 'e-1', 'e1.5', 'E1', 'e 1', '1', 'e01', 'e1x']) {
      const outcome = resolveReference(document, token);
      expect(
        !outcome.resolved && outcome.because,
        `"${token}" must be reported as never issued`,
      ).toBe(REFERENCE_REFUSAL.neverIssued);
    }
  });

  it('rejects e01 because this scheme never mints it — one ordinal, one spelling', () => {
    // Accepting a second spelling of one ordinal would make "was this issued" answerable two ways, and
    // the two answers would eventually disagree.
    html('<button>Save</button>');
    const ref = refFor('Save');
    expect(ref).not.toContain('e0');
    expect(resolveReference(document, 'e01').resolved).toBe(false);
  });
});

describe('tokens are never reused', () => {
  it('mints a disjoint set on every snapshot of the same unchanged page', () => {
    // The property that makes the silent wrong-node failure UNREACHABLE rather than merely guarded: a
    // token can never come to mean a second element.
    html('<button>Save</button><button>Cancel</button>');
    const first = takeSnapshot(document).elements.map((one) => one.ref);
    const second = takeSnapshot(document).elements.map((one) => one.ref);
    const third = takeSnapshot(document).elements.map((one) => one.ref);

    expect(first).toHaveLength(2);
    const all = [...first, ...second, ...third];
    expect(new Set(all).size, 'every token across three snapshots is distinct').toBe(all.length);
  });

  it('keeps minting forward after an explicit invalidation', () => {
    html('<button>Save</button>');
    const before = refFor('Save');
    invalidateDomRefs(document);
    const after = refFor('Save');
    expect(after).not.toBe(before);
  });
});

describe('a partial snapshot never becomes the live table', () => {
  it('leaves no table live when a snapshot could not complete', () => {
    // The table is installed WHOLE at the end of the pass. A half-populated table would hand an agent
    // references to a page state nobody described — and every one of them would resolve.
    html('<button>Save</button>');
    const ref = refFor('Save');
    // A pass that throws: `title` is read at the end, after every mint.
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
    Object.defineProperty(document, 'title', {
      configurable: true,
      get() {
        throw new Error('reading the title failed');
      },
    });
    expect(() => takeSnapshot(document)).toThrow();
    if (original !== undefined) Object.defineProperty(Document.prototype, 'title', original);
    // @ts-expect-error restoring the instance property so later cases see the prototype's accessor
    delete document.title;

    // The OLD reference is superseded — the epoch bumped when the failed pass began, which is what
    // stops a thrown snapshot leaving every previously issued token quietly still valid.
    const outcome = resolveReference(document, ref);
    expect(!outcome.resolved && outcome.because).toBe(REFERENCE_REFUSAL.supersededBySnapshot);
  });
});
