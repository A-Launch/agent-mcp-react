// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { fillabilityOf, interactabilityOf, NOT_INTERACTABLE } from '../../../src/dom/interact.ts';

// Whether an element may be operated — and, in two cases, proof that THIS LIBRARY is what refuses it.
//
// **Measured before these were written, and it is why they exist:**
//
//     disabled              a programmatic .click() is REFUSED by the platform
//     inert ancestor        a programmatic .click() goes THROUGH
//     pointer-events: none  a programmatic .click() goes THROUGH
//
// So the platform is unreliable in both directions. Without a check, a click on a disabled element
// reports success for a call that did nothing; a click on an inert one performs an action no person at
// the same page could perform.
//
// The two cases at the bottom assert that a raw `element.click()` DOES fire the handler. Without them
// the inert and pointer-events cases above would pass for an implementation that does nothing at all —
// which is the shape of a guard that reports success.

function html(markup: string): void {
  document.body.innerHTML = markup;
}

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('an element that can be operated', () => {
  it('is operable when nothing stops it — the case that stops every other one passing vacuously', () => {
    html('<button id="a">Save</button>');
    expect(interactabilityOf(el('a')).operable).toBe(true);
  });
});

describe('the six reasons an element cannot be operated, each named', () => {
  it('refuses one a person cannot see', () => {
    // The RESIDUAL cause, reported last: hidden by display, visibility, the hidden attribute or
    // aria-hidden — the reasons that are not more specifically one of the causes below. `inert` is
    // also a reason perceivability refuses, and it is checked FIRST so the more actionable cause wins.
    html('<div style="display:none"><button id="a">Save</button></div>');
    const outcome = interactabilityOf(el('a'));
    expect(!outcome.operable && outcome.because).toBe(NOT_INTERACTABLE.notPerceivable);
  });

  it('refuses a disabled control — which the platform swallows SILENTLY', () => {
    html('<button id="a" disabled>Save</button>');
    const outcome = interactabilityOf(el('a'));
    expect(!outcome.operable && outcome.because).toBe(NOT_INTERACTABLE.disabled);
  });

  it('refuses aria-disabled, on the element and on an ancestor', () => {
    html('<button id="a" aria-disabled="true">Save</button>');
    expect(
      (() => {
        const o = interactabilityOf(el('a'));
        return !o.operable && o.because;
      })(),
    ).toBe(NOT_INTERACTABLE.ariaDisabled);
    html('<div aria-disabled="true"><button id="b">Save</button></div>');
    const nested = interactabilityOf(el('b'));
    expect(!nested.operable && nested.because).toBe(NOT_INTERACTABLE.ariaDisabled);
  });

  it('accepts aria-disabled="false", which is a value and not a presence check', () => {
    html('<button id="a" aria-disabled="false">Save</button>');
    expect(interactabilityOf(el('a')).operable).toBe(true);
  });

  it('refuses an inert subtree', () => {
    html('<div inert><button id="a">Save</button></div>');
    const outcome = interactabilityOf(el('a'));
    expect(!outcome.operable && outcome.because).toBe(NOT_INTERACTABLE.inert);
  });

  it('refuses pointer-events: none', () => {
    html('<button id="a" style="pointer-events:none">Save</button>');
    const outcome = interactabilityOf(el('a'));
    expect(!outcome.operable && outcome.because).toBe(NOT_INTERACTABLE.pointerEventsNone);
  });

  it('refuses a read-only field, for a fill', () => {
    html('<input id="a" readonly value="fixed">');
    const outcome = fillabilityOf(el('a'));
    expect(!outcome.operable && outcome.because).toBe(NOT_INTERACTABLE.readOnly);
  });
});

describe('what dom.fill accepts', () => {
  it('accepts the inputs that hold a typed value, and a textarea', () => {
    html('<input id="a"><input id="b" type="search"><textarea id="c"></textarea>');
    for (const id of ['a', 'b', 'c']) {
      expect(fillabilityOf(el(id)).operable, `${id} should be fillable`).toBe(true);
    }
  });

  it('refuses a select, a checkbox and a button — each is another tool’s, or nothing’s', () => {
    html(`
      <select id="a"><option>One</option></select>
      <input id="b" type="checkbox">
      <button id="c">Save</button>
      <div id="d" contenteditable="true">rich</div>
    `);
    for (const id of ['a', 'b', 'c', 'd']) {
      const outcome = fillabilityOf(el(id));
      expect(!outcome.operable && outcome.because, `${id} should be refused`).toBe(
        NOT_INTERACTABLE.notAField,
      );
    }
  });
});

describe('the platform does NOT refuse what this library refuses', () => {
  // **These two cases are the reason the inert and pointer-events cases above are not vacuous.**
  // A synthetic click dispatches an event and skips hit-testing entirely, so neither condition stops
  // it. If that ever changes, these go red and the ones above become redundant — which is a fact worth
  // learning loudly rather than a reason to leave them out.

  it('fires a handler on an INERT element when clicked programmatically', () => {
    html('<div inert><button id="a">Save</button></div>');
    let fired = 0;
    el('a').addEventListener('click', () => {
      fired += 1;
    });
    el('a').click();
    expect(fired, 'the platform lets a synthetic click into an inert subtree').toBe(1);
    // ...and this library refuses it.
    expect(interactabilityOf(el('a')).operable).toBe(false);
  });

  it('fires a handler under pointer-events: none when clicked programmatically', () => {
    html('<button id="a" style="pointer-events:none">Save</button>');
    let fired = 0;
    el('a').addEventListener('click', () => {
      fired += 1;
    });
    el('a').click();
    expect(fired, 'a synthetic click skips hit-testing').toBe(1);
    expect(interactabilityOf(el('a')).operable).toBe(false);
  });

  it('does NOT fire a handler on a disabled element — the opposite failure', () => {
    // The other direction: here the platform refuses, silently. Without this library's check the tool
    // would dispatch, nothing would happen, and the agent would be told it pressed the button.
    html('<button id="a" disabled>Save</button>');
    let fired = 0;
    el('a').addEventListener('click', () => {
      fired += 1;
    });
    el('a').click();
    expect(fired, 'the platform swallows it, and says nothing').toBe(0);
    expect(interactabilityOf(el('a')).operable).toBe(false);
  });
});
