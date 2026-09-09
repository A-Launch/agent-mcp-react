// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { isPerceivable } from '../../../src/dom/perceivable.ts';

// Whether a person can perceive an element — decided WITHOUT reading layout, and that is the whole
// subject of this file rather than an implementation detail it happens to have.
//
// **Measured before it was written** (research R2). Under this exact environment:
//
//   checkVisibility exists:  undefined
//   plain visible button:    offsetParent = null,  getClientRects().length = 0
//   display:none button:     offsetParent = null,  getClientRects().length = 0
//
// So the three obvious implementations are all unusable here. `checkVisibility()` does not exist;
// `offsetParent` and `getClientRects()` report the PLAINLY VISIBLE control exactly as they report the
// hidden one, because jsdom performs no layout. An implementation reaching for any of them returns an
// EMPTY SNAPSHOT in the environment three of this repository's four test projects run in — and looks
// correct in a browser, so every case above it would be written green against a serializer that
// returns nothing.
//
// **And the ancestor walk is not a jsdom workaround.** `getComputedStyle` does not cascade `display`:
// a button inside a `display:none` div reports `inline-block`, here AND in a real browser, because the
// computed value is not the used value. The walk is the correct implementation in both.
//
// The first case below is the guard against all of that: a plainly visible control MUST be perceivable.
// Without it, every other case in this file passes for a function that always returns false.

function html(markup: string): void {
  document.body.innerHTML = markup;
}

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('an element a person can perceive', () => {
  it('is perceivable when nothing hides it — the case that stops every other case passing vacuously', () => {
    html('<button id="a">Save</button>');
    expect(isPerceivable(el('a'))).toBe(true);
  });

  it('is perceivable when it is deep in ordinary markup', () => {
    html('<div><section><p><button id="a">Save</button></p></section></div>');
    expect(isPerceivable(el('a'))).toBe(true);
  });
});

describe('the declarative ways of hiding something', () => {
  it('refuses display:none on the element itself', () => {
    html('<button id="a" style="display:none">Save</button>');
    expect(isPerceivable(el('a'))).toBe(false);
  });

  it('refuses display:none on an ANCESTOR, which the element’s own computed style does not report', () => {
    html('<div style="display:none"><button id="a">Save</button></div>');
    // The measurement this case exists for: the element itself still reports a visible display.
    expect(getComputedStyle(el('a')).display).not.toBe('none');
    expect(isPerceivable(el('a'))).toBe(false);
  });

  it('refuses visibility:hidden, on the element and on an ancestor', () => {
    html('<button id="a" style="visibility:hidden">Save</button>');
    expect(isPerceivable(el('a'))).toBe(false);
    html('<div style="visibility:hidden"><button id="b">Save</button></div>');
    expect(isPerceivable(el('b'))).toBe(false);
  });

  it('refuses the hidden attribute', () => {
    html('<button id="a" hidden>Save</button>');
    expect(isPerceivable(el('a'))).toBe(false);
  });

  it('refuses aria-hidden, on the element and on an ancestor', () => {
    html('<button id="a" aria-hidden="true">Save</button>');
    expect(isPerceivable(el('a'))).toBe(false);
    html('<div aria-hidden="true"><button id="b">Save</button></div>');
    expect(isPerceivable(el('b'))).toBe(false);
  });

  it('accepts aria-hidden="false", which is a value and not a presence check', () => {
    html('<button id="a" aria-hidden="false">Save</button>');
    expect(isPerceivable(el('a'))).toBe(true);
  });

  it('refuses inert on an ancestor', () => {
    html('<div inert><button id="a">Save</button></div>');
    expect(isPerceivable(el('a'))).toBe(false);
  });

  it('refuses a hidden input, which is never perceivable whatever else is true of it', () => {
    html('<input id="a" type="hidden" value="csrf">');
    expect(isPerceivable(el('a'))).toBe(false);
  });

  it('refuses an element that is not in the document at all', () => {
    const orphan = document.createElement('button');
    expect(isPerceivable(orphan)).toBe(false);
  });
});

describe('what perceivability deliberately does NOT decide', () => {
  it('accepts an element that is merely zero-sized or covered', () => {
    // **Not a gap — a boundary.** This reports what the page DECLARES. Whether an element can actually
    // be reached is discovered when something tries to touch it, which the DOM write tools report as
    // MCP_DOM_NOT_INTERACTABLE at the point of use. Asserted rather than left implicit, so a future
    // reader does not "fix" this by reaching for layout that does not exist here (research R2).
    html('<button id="a" style="width:0;height:0;overflow:hidden">Save</button>');
    expect(isPerceivable(el('a'))).toBe(true);
  });
});
