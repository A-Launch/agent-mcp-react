// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type SemanticElement,
  SNAPSHOT_ELEMENT_LIMIT,
  takeSnapshot,
  textOf,
} from '../../../src/dom/snapshot.ts';

// What a snapshot says about a page, and — with more cases than anything else here — what it does not.
//
// The assertion carrying the most weight is `carries no markup anywhere`. The requirement
// (`docs/dom-inspection.md#what-an-agent-gets`) is that `dom.snapshot` returns roles and accessible
// names rather than page HTML, and the failure mode is not a
// deliberate decision to serialize the DOM: it is one convenience field added later, by someone who
// wanted a selector to debug with.

function html(markup: string): void {
  document.body.innerHTML = markup;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Customers';
});

function byName(elements: readonly SemanticElement[], name: string): SemanticElement | undefined {
  return elements.find((one) => one.name === name);
}

describe('the shape a snapshot returns', () => {
  it('carries the page’s url and title', () => {
    html('<button>Save</button>');
    const snapshot = takeSnapshot(document);
    expect(snapshot.url).toBe(window.location.href);
    expect(snapshot.title).toBe('Customers');
  });

  it('gives every element a ref and a role', () => {
    html('<button>Save</button><input aria-label="Search"><a href="/x">Home</a>');
    const { elements } = takeSnapshot(document);
    expect(elements).toHaveLength(3);
    for (const element of elements) {
      expect(element.ref).toMatch(/^e[1-9][0-9]*$/);
      expect(typeof element.role).toBe('string');
    }
    expect(elements.map((one) => one.role)).toEqual(['button', 'textbox', 'link']);
  });

  it('reports elements in document order', () => {
    html('<button>One</button><button>Two</button><button>Three</button>');
    expect(takeSnapshot(document).elements.map((one) => one.name)).toEqual(['One', 'Two', 'Three']);
  });

  it('omits an element nothing in the role vocabulary describes', () => {
    // A page of `<div>`s is not a page of controls, and reporting them would fill the budget with
    // things an agent has no business addressing.
    html('<div>text</div><span>more</span><button>Save</button>');
    const { elements } = takeSnapshot(document);
    expect(elements).toHaveLength(1);
    expect(elements[0]?.role).toBe('button');
  });

  it('honours an explicit role, and ignores one outside the closed set', () => {
    html('<div role="status">3 customers match</div><div role="widget">?</div>');
    const { elements } = takeSnapshot(document);
    expect(elements).toHaveLength(1);
    expect(elements[0]?.role).toBe('status');
  });

  it('reports an anchor as a link only when it can be followed', () => {
    html('<a href="/x">Followable</a><a>Not followable</a>');
    const { elements } = takeSnapshot(document);
    expect(elements).toHaveLength(1);
    expect(elements[0]?.name).toBe('Followable');
  });
});

describe('the three kinds an agent needs to see', () => {
  it('reports controls, structure, AND text that says what happened', () => {
    // A snapshot of only interactive controls would give an agent refs for every button on a
    // failed form and none for the message explaining the failure — which makes `dom.get_text`, the
    // one tool for reading the page, unable to reach the thing most worth reading.
    html(`
      <h1>Customers</h1>
      <nav aria-label="Primary"><a href="/x">Home</a></nav>
      <button>Export</button>
      <div role="alert">Export failed: the report is too large</div>
    `);
    const roles = takeSnapshot(document).elements.map((one) => one.role);
    expect(roles).toContain('heading');
    expect(roles).toContain('navigation');
    expect(roles).toContain('button');
    expect(roles).toContain('alert');
  });
});

describe('accessible names', () => {
  it('reads each of the six sources in its declared precedence', () => {
    html(`
      <span id="remote">From labelledby</span>
      <button aria-labelledby="remote" aria-label="losing">A</button>
      <button aria-label="From aria-label">B</button>
      <label for="withlabel">From label</label><input id="withlabel">
      <input type="image" alt="From alt" aria-label="">
      <button title="From title"></button>
      <button>From own text</button>
    `);
    const names = takeSnapshot(document).elements.map((one) => one.name);
    expect(names).toContain('From labelledby');
    expect(names).toContain('From aria-label');
    expect(names).toContain('From label');
    expect(names).toContain('From alt');
    expect(names).toContain('From title');
    expect(names).toContain('From own text');
  });

  it('reports a nameless element with NO name key, never a fabricated one', () => {
    html('<button></button>');
    const element = takeSnapshot(document).elements[0];
    expect(element?.role).toBe('button');
    expect('name' in (element ?? {})).toBe(false);
  });

  it('falls through a dangling aria-labelledby to the next real source', () => {
    html('<button aria-labelledby="nothing-here">Own text</button>');
    expect(takeSnapshot(document).elements[0]?.name).toBe('Own text');
  });
});

describe('values and disabled state', () => {
  it('reports a textbox value, and omits the key when it is empty', () => {
    html('<input aria-label="Search" value="acme"><input aria-label="Empty">');
    const { elements } = takeSnapshot(document);
    expect(byName(elements, 'Search')?.value).toBe('acme');
    expect('value' in (byName(elements, 'Empty') ?? {})).toBe(false);
  });

  it('reports checked state for a checkbox', () => {
    html(
      '<input type="checkbox" aria-label="Active" checked><input type="checkbox" aria-label="Idle">',
    );
    const { elements } = takeSnapshot(document);
    expect(byName(elements, 'Active')?.value).toBe('checked');
    expect(byName(elements, 'Idle')?.value).toBe('unchecked');
  });

  it('reports a select’s visible LABEL rather than its value attribute', () => {
    // The agent is being told what is on screen. `value="hlth"` is not on screen.
    html('<select aria-label="Health"><option value="hlth">Healthy</option></select>');
    expect(takeSnapshot(document).elements[0]?.value).toBe('Healthy');
  });

  it('marks disabled only when true, from either spelling', () => {
    html(`
      <button disabled>Native</button>
      <button aria-disabled="true">Aria</button>
      <button aria-disabled="false">Not disabled</button>
      <button>Plain</button>
    `);
    const { elements } = takeSnapshot(document);
    expect(byName(elements, 'Native')?.disabled).toBe(true);
    expect(byName(elements, 'Aria')?.disabled).toBe(true);
    expect('disabled' in (byName(elements, 'Not disabled') ?? {})).toBe(false);
    expect('disabled' in (byName(elements, 'Plain') ?? {})).toBe(false);
  });
});

describe('a snapshot carries no markup anywhere', () => {
  it('leaks no tag name, attribute, class, id or html fragment into any field', () => {
    // The no-markup requirement, asserted over the SERIALIZED result rather than field by field — a future convenience field
    // would have to be added deliberately past this, instead of slipping in beside the ones a
    // field-by-field check happened to name.
    html(`
      <div class="secret-class" id="secret-id" data-token="tok_live_abc">
        <button class="btn primary" data-testid="save" title="Save">Save</button>
        <input type="text" class="field" name="search" aria-label="Search" value="acme">
      </div>
    `);
    const serialized = JSON.stringify(takeSnapshot(document));

    for (const forbidden of [
      'secret-class',
      'secret-id',
      'tok_live_abc',
      'data-token',
      'data-testid',
      'btn primary',
      '<div',
      '<button',
      'class=',
      'innerHTML',
    ]) {
      expect(serialized, `a snapshot must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('the bound', () => {
  it('returns at most the limit, in document order, and reports how many it omitted', () => {
    const many = Array.from(
      { length: SNAPSHOT_ELEMENT_LIMIT + 100 },
      (_unused, index) => `<button>Row ${index}</button>`,
    ).join('');
    html(many);
    const snapshot = takeSnapshot(document);
    expect(snapshot.elements).toHaveLength(SNAPSHOT_ELEMENT_LIMIT);
    expect(snapshot.truncated).toBe(100);
    // Document order, so truncation is predictable: what a person sees first survives.
    expect(snapshot.elements[0]?.name).toBe('Row 0');
    expect(snapshot.elements.at(-1)?.name).toBe(`Row ${SNAPSHOT_ELEMENT_LIMIT - 1}`);
  });

  it('carries no truncated key at all when nothing was omitted', () => {
    html('<button>Only one</button>');
    expect('truncated' in takeSnapshot(document)).toBe(false);
  });
});

describe('reading an element’s text', () => {
  it('returns its visible text, whitespace collapsed', () => {
    html('<div role="status">  3 customers\n   match  </div>');
    const element = document.querySelector('[role="status"]') as Element;
    expect(textOf(element)).toBe('3 customers match');
  });

  it('returns an empty string for an element with no text, which is an answer and not an error', () => {
    html('<button></button>');
    expect(textOf(document.querySelector('button') as Element)).toBe('');
  });
});

describe('a container is named only if somebody labelled it', () => {
  it('does not take a landmark’s name from its own subtree', () => {
    // **Found in a live browser, not by a case.** The demonstrator's `banner` reported a name of
    // "Customer bookA filterable SaaS page. Everything an a…" — its entire subtree, truncated to the
    // name limit. A container's text content is everything inside it, so deriving a name from one
    // turns every landmark into a blob of the page: useless to an agent matching on names, and it
    // spends the payload on text already reported element by element.
    html(`
      <header>
        <h1>Customer book</h1>
        <p>A filterable page. Everything an agent can do here a person can do too.</p>
      </header>
    `);
    const banner = takeSnapshot(document).elements.find((one) => one.role === 'banner');
    expect(banner).toBeDefined();
    expect('name' in (banner ?? {}), 'a landmark with no label reports no name').toBe(false);
  });

  it('still names a landmark that WAS labelled', () => {
    html('<nav aria-label="Primary"><a href="/x">Home</a></nav>');
    const nav = takeSnapshot(document).elements.find((one) => one.role === 'navigation');
    expect(nav?.name).toBe('Primary');
  });

  it('keeps naming the roles that ARE named by what they say', () => {
    html(`
      <button>Save</button>
      <h2>Filters</h2>
      <div role="status">3 customers match</div>
      <ul><li>One</li></ul>
    `);
    const { elements } = takeSnapshot(document);
    expect(byName(elements, 'Save')?.role).toBe('button');
    expect(byName(elements, 'Filters')?.role).toBe('heading');
    // `status` is a deliberate addition to ARIA's name-from-content list: a live region's content IS
    // the message, and it is the single thing an agent most needs on a page that has just failed.
    expect(byName(elements, '3 customers match')?.role).toBe('status');
    expect(byName(elements, 'One')?.role).toBe('listitem');
    // ...and the list CONTAINING it is not named by its contents.
    const list = elements.find((one) => one.role === 'list');
    expect('name' in (list ?? {})).toBe(false);
  });
});
