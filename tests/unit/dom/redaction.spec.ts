// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { controlValueOf, takeSnapshot, textOf } from '../../../src/dom/snapshot.ts';

// The redaction guarantees a snapshot owes: a password value is never carried, a hidden input is
// never exposed, and nothing is included automatically
// (`docs/reference-capabilities.md#what-the-library-redacts-and-what-it-does-not`). The most
// valuable cases in this directory.
//
// A snapshot is the widest disclosure channel this library has ever opened. Everything else exposes
// what an application author chose to publish; this exposes whatever happens to be on screen. So these
// are refusals with test cases rather than defaults, and each has a break-it recorded in the PR
// (`CONTRIBUTING.md#8-testing`).
//
// **The shape of the guarantee matters as much as the guarantee.** Two of the three hold by
// CONSTRUCTION rather than by filtering:
//
//   - Attributes are never traversed, so nothing leaks because a deny-list missed it.
//   - `dom.get_text` has no path to `value` at all, so there is nothing there to redact.
//
// Only the password branch is an explicit check, and it is the one the break-it targets.

function html(markup: string): void {
  document.body.innerHTML = markup;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a password field', () => {
  it('is PRESENT with its role and name — an agent must see that a password is being asked for', () => {
    html('<label for="p">Password</label><input id="p" type="password" value="hunter2">');
    const element = takeSnapshot(document).elements.find((one) => one.name === 'Password');
    expect(element).toBeDefined();
    expect(element?.role).toBe('textbox');
  });

  it('never carries its value, in any field of the whole result', () => {
    html('<label for="p">Password</label><input id="p" type="password" value="hunter2-secret">');
    const snapshot = takeSnapshot(document);
    expect('value' in (snapshot.elements[0] ?? {})).toBe(false);
    // Over the serialized result, so a value arriving through some other field is caught too.
    expect(JSON.stringify(snapshot)).not.toContain('hunter2-secret');
  });

  it('leaks nothing through dom.get_text either', () => {
    // Structural rather than a second check: `textOf` reads text content, and an input's value
    // is not its text content — so there is no path here to redact.
    html('<input id="p" type="password" value="hunter2-secret" aria-label="Password">');
    const element = document.getElementById('p') as Element;
    expect(textOf(element)).toBe('');
    expect(textOf(element)).not.toContain('hunter2');
  });

  it('leaks nothing through its accessible name, even when the value would be the only text', () => {
    html('<input type="password" value="hunter2-secret" aria-label="Password">');
    expect(JSON.stringify(takeSnapshot(document))).not.toContain('hunter2-secret');
  });
});

describe('a hidden input', () => {
  it('does not appear at all, and its value appears nowhere', () => {
    html(`
      <input type="hidden" name="csrf" value="csrf-token-abcdef">
      <button>Submit</button>
    `);
    const snapshot = takeSnapshot(document);
    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.elements[0]?.role).toBe('button');
    expect(JSON.stringify(snapshot)).not.toContain('csrf-token-abcdef');
  });

  it('is refused even when given an explicit role that IS in the vocabulary', () => {
    html('<input type="hidden" role="textbox" aria-label="Sneaky" value="csrf-token-abcdef">');
    expect(JSON.stringify(takeSnapshot(document))).not.toContain('csrf-token-abcdef');
  });

  it('is refused by the VALUE SITE too, tested where that branch is actually reachable', () => {
    // **This case exists because a break-it did not go red.** Deleting the hidden branch from the value
    // site changed nothing through `takeSnapshot`, because a hidden input is already refused twice
    // before it gets there — so the source comment claiming two independent reasons was a claim nothing
    // checked, which is worse than one reason honestly stated.
    //
    // Driving the value function directly is what makes the second guard real. Both layers now have
    // their own case, so deleting either one turns a distinct case red — and a future change that
    // relaxes perceivability does not silently take the value guard's coverage with it.
    html('<input id="h" type="hidden" value="csrf-token-abcdef">');
    expect(controlValueOf(document.getElementById('h') as Element)).toBeUndefined();
  });

  it('and the value site refuses a password independently of the snapshot walk', () => {
    html('<input id="p" type="password" value="hunter2-secret">');
    expect(controlValueOf(document.getElementById('p') as Element)).toBeUndefined();
  });
});

describe('attributes', () => {
  it('leak nothing, because they are never traversed rather than filtered', () => {
    // Nothing reaches the agent automatically, and a token in an attribute is exactly what
    // "automatically" would mean here. The distinction is the point: a serializer that walked attributes and removed
    // the sensitive ones leaks the first attribute nobody thought of. This one reads only the fields
    // the projection names, so absence is by construction.
    html(`
      <button
        id="tok_live_in_id"
        class="tok_live_in_class"
        data-session="tok_live_in_data"
        data-user-email="person@example.com"
        name="tok_live_in_name"
      >Save</button>
    `);
    const serialized = JSON.stringify(takeSnapshot(document));
    for (const secret of [
      'tok_live_in_id',
      'tok_live_in_class',
      'tok_live_in_data',
      'person@example.com',
      'tok_live_in_name',
    ]) {
      expect(serialized, `a snapshot must not contain ${secret}`).not.toContain(secret);
    }
  });
});

describe('redaction is unconditional', () => {
  it('does not depend on any capability, build mode or observability setting', () => {
    // Redaction is unconditional: there is no parameter to vary, and that IS the assertion: `takeSnapshot` takes a
    // document and nothing else, so there is no configuration in which redaction differs. A signature
    // that admitted an options object would be the place a `verbose` branch eventually appeared —
    // which is the failure `platform-gotchas` pre-judged for this exact module.
    html('<input type="password" value="hunter2-secret" aria-label="Password">');
    expect(takeSnapshot.length).toBe(1);
    for (let run = 0; run < 3; run += 1) {
      expect(JSON.stringify(takeSnapshot(document))).not.toContain('hunter2-secret');
    }
  });
});
