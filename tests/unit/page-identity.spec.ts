// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IDENTITY_UNAVAILABLE,
  isIdentityUnavailableCode,
  PageIdentityError,
  pageInstanceId,
} from '../../src/page-identity.ts';

// The page instance identity: one value per document, minted on first read, and refused rather than
// approximated when it cannot be produced.
//
// A DOM is declared because a page identity belongs to the document — the module stores it there, for
// the same reason the provider claim is stored there. A unit test of the document boundary needs a
// document.
//
// **The identity is deliberately not resettable through any API.** Uniqueness is the whole point, and
// an override would be a way to reintroduce the collision this exists to fix. So a case that wants a
// fresh page instance removes the marker from the host directly, exactly as a new document would not
// have one. That is the test manipulating the environment, never the library offering a back door.

const KEY = Symbol.for('@agent-mcp/react.page-instance-identity');

/** Simulates a fresh page instance — a reload, or a second document. */
function newPageInstance(): void {
  delete (document as unknown as Record<symbol, unknown>)[KEY];
}

afterEach(() => {
  newPageInstance();
  vi.unstubAllGlobals();
});

describe('a page instance has one identity', () => {
  it('produces a value on first read', () => {
    newPageInstance();
    expect(pageInstanceId()).toMatch(/\S/);
  });

  it('returns the same value on every later read', () => {
    newPageInstance();
    const first = pageInstanceId();
    // Many reads rather than two: a mint that ran per call would still pass a two-read case if the
    // second happened to be compared against a stale variable.
    const rest = [pageInstanceId(), pageInstanceId(), pageInstanceId()];
    expect(rest).toEqual([first, first, first]);
  });

  it('gives a DIFFERENT value to a different page instance', () => {
    newPageInstance();
    const first = pageInstanceId();
    newPageInstance();
    const second = pageInstanceId();

    // The assertion this feature exists for. Two copies of one application sharing an identity is the
    // defect: an agent addresses one page and reaches the other, and every result looks normal.
    expect(second).not.toBe(first);
  });

  it('mints nothing until it is read', () => {
    newPageInstance();
    const before = Object.getOwnPropertySymbols(document).includes(KEY);
    expect(before).toBe(false);

    pageInstanceId();

    expect(Object.getOwnPropertySymbols(document).includes(KEY)).toBe(true);
  });

  it('keeps the marker out of an enumeration of the document', () => {
    newPageInstance();
    pageInstanceId();
    // Non-enumerable, so a page script walking the document does not trip over it. It is not a secret
    // — this is hygiene, not redaction, and the case says so rather than implying the value is hidden.
    const descriptor = Object.getOwnPropertyDescriptor(document, KEY);
    expect(descriptor?.enumerable).toBe(false);
    expect(descriptor?.writable).toBe(false);
  });
});

describe('two bundled copies of this library agree', () => {
  it('resolves the same identity through the shared well-known key', async () => {
    newPageInstance();
    const first = pageInstanceId();

    // A second module instance, as a separately bundled copy would be: its own module scope, its own
    // closure, its own everything except the well-known symbol. `Symbol.for` is what makes it see the
    // first copy's value; a per-module `Symbol()` would be invisible here and this case would fail.
    //
    // This is the micro-frontend case, and it is the reason the key is what it is: two copies each
    // minting their own identity would show an agent two tabs where a person sees one page.
    vi.resetModules();
    const secondCopy = await import('../../src/page-identity.ts');

    expect(secondCopy.pageInstanceId()).toBe(first);
  });
});

describe('an identity that cannot be produced is refused, never approximated', () => {
  it('refuses when the platform offers no source of unique values', () => {
    newPageInstance();
    vi.stubGlobal('crypto', {});

    expect(() => pageInstanceId()).toThrowError(PageIdentityError);
    try {
      pageInstanceId();
    } catch (error) {
      expect((error as PageIdentityError).code).toBe(IDENTITY_UNAVAILABLE.noUniqueSource);
    }
  });

  it('names the insecure context when that is what it is, because that one is fixable', () => {
    newPageInstance();
    vi.stubGlobal('crypto', {});
    vi.stubGlobal('isSecureContext', false);

    try {
      pageInstanceId();
      expect.unreachable('a page with no unique-value source must not receive an identity');
    } catch (error) {
      // An operator meeting this is usually testing on a phone against a laptop's dev server. Telling
      // them the environment is deficient sends them nowhere; telling them to use HTTPS or localhost
      // is something they can act on.
      expect((error as PageIdentityError).message).toMatch(/HTTPS|localhost/);
    }
  });

  it('substitutes nothing — a refused mint leaves no marker behind', () => {
    newPageInstance();
    vi.stubGlobal('crypto', {});

    expect(() => pageInstanceId()).toThrow();

    // The failure this guards: a partially written marker, or a fallback value stored "just in case",
    // would make the NEXT read succeed with a value nothing unique produced.
    expect(Object.getOwnPropertySymbols(document).includes(KEY)).toBe(false);
  });

  it('refuses a source that answers with something that is not a value', () => {
    newPageInstance();
    // A broken implementation is not a working one. Truthiness would accept an object here and store
    // it, and the identity would then be `[object Object]` in every URL it reached.
    vi.stubGlobal('crypto', { randomUUID: () => '' });

    expect(() => pageInstanceId()).toThrowError(PageIdentityError);
  });

  it('refuses a key another script defined AS undefined, rather than reading it as absent', () => {
    newPageInstance();
    // The edge a value check misses. A `!== undefined` test reads this as "no marker", and the mint
    // then either overwrites somebody else's property or — if they made it non-configurable — throws a
    // raw TypeError that no caller can classify. Presence is the question, not value.
    Object.defineProperty(document, KEY, { value: undefined, configurable: true });

    try {
      pageInstanceId();
      expect.unreachable('an occupied key must not be read as an empty one');
    } catch (error) {
      expect((error as PageIdentityError).code).toBe(IDENTITY_UNAVAILABLE.markerUnusable);
    }
  });

  it('refuses a source whose generator is not callable, rather than leaking a raw TypeError', () => {
    newPageInstance();
    // A malformed or legacy polyfill. Optional calling guards null and undefined and nothing else, so
    // without a callability check this path throws an unclassified TypeError — the one outcome this
    // module exists to never produce: an unexpected state is classified and raised, never left as a
    // hidden unknown.
    vi.stubGlobal('crypto', { randomUUID: 'not a function' });

    try {
      pageInstanceId();
      expect.unreachable('a source that cannot generate must be refused, not invoked');
    } catch (error) {
      expect(error).toBeInstanceOf(PageIdentityError);
      expect((error as PageIdentityError).code).toBe(IDENTITY_UNAVAILABLE.noUniqueSource);
    }
  });

  it('refuses a marker it did not write rather than overwriting it', () => {
    newPageInstance();
    Object.defineProperty(document, KEY, { value: { notAnId: true }, configurable: true });

    try {
      pageInstanceId();
      expect.unreachable('an unreadable marker must not be repaired');
    } catch (error) {
      expect((error as PageIdentityError).code).toBe(IDENTITY_UNAVAILABLE.markerUnusable);
    }

    // Refused, not replaced. Overwriting would mean any script could hand this library a broken value
    // and have the identity silently reissued — the same outcome as having no rule at all.
    const held = (document as unknown as Record<symbol, unknown>)[KEY];
    expect(held).toEqual({ notAnId: true });
  });
});

describe('the failure vocabulary is a closed set', () => {
  it('derives membership from the dictionary rather than from a second list', () => {
    for (const code of Object.values(IDENTITY_UNAVAILABLE)) {
      expect(isIdentityUnavailableCode(code)).toBe(true);
    }
    expect(isIdentityUnavailableCode('MCP_PAGE_IDENTITY_SOMETHING_ELSE')).toBe(false);
  });

  it('does not borrow the registry vocabulary for a condition it shares', () => {
    // The insecure-context condition is the same one the registry boundary refuses on, and reusing its
    // code was the obvious move. It would report a REGISTRY cause for a failure that has nothing to do
    // with the registry, sending a reader after a problem that is not there.
    for (const code of Object.values(IDENTITY_UNAVAILABLE)) {
      expect(code.startsWith('MCP_PAGE_IDENTITY_')).toBe(true);
    }
  });
});
