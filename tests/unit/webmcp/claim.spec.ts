// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimDocument, currentClaimHolder, releaseDocument } from '../../../src/webmcp/claim.ts';
import { CLAIM_REFUSED } from '../../../src/webmcp/errors.ts';

// One provider per document, and the diagnosis that appears when there are two.
//
// The value of this rule is entirely in what it replaces. Without it, two providers is a working
// configuration that produces wrong answers: two ownership records over one registry, each calling the
// other's tools foreign, every symptom pointing at "another script on the page". Every one of those
// symptoms is the specified rules behaving correctly, which is what makes it so expensive to diagnose.

const CLAIM_KEY = Symbol.for('@agent-mcp/react.document-provider-claim');

function clearClaim(): void {
  Reflect.deleteProperty(document as object, CLAIM_KEY);
}

/** Puts an arbitrary value under the claim key, standing in for a page script occupying it. */
function occupyKeyWith(value: unknown): void {
  Object.defineProperty(document, CLAIM_KEY, { value, configurable: true, enumerable: false });
}

afterEach(clearClaim);

describe('claiming the document', () => {
  it('succeeds when nothing holds it', () => {
    claimDocument('provider-a');

    expect(currentClaimHolder()).toBe('provider-a');
  });

  it('refuses a second provider and names the active one', () => {
    claimDocument('provider-a');

    try {
      claimDocument('provider-b');
      expect.unreachable('the second claim should have been refused');
    } catch (error) {
      // Naming the holder is the point. "A provider is already active" without saying which one sends
      // the reader looking through the page for a script that is not there.
      expect(error).toMatchObject({
        code: CLAIM_REFUSED.providerAlreadyActive,
        subject: 'provider-a',
      });
      expect((error as Error).message).toContain('provider-a');
    }

    // And the first claim still stands. A refused second claim must not disturb the first.
    expect(currentClaimHolder()).toBe('provider-a');
  });

  it('succeeds again after the holder releases — remount, hot reload, double-invoked effect', () => {
    claimDocument('provider-a');
    releaseDocument('provider-a');

    expect(() => claimDocument('provider-a')).not.toThrow();
    expect(currentClaimHolder()).toBe('provider-a');
  });
});

describe('releasing the document', () => {
  it('refuses a release presented by anything but the holder', () => {
    claimDocument('provider-a');

    expect(() => releaseDocument('provider-b')).toThrowError(
      expect.objectContaining({ code: CLAIM_REFUSED.notTheHolder }) as Error,
    );

    // The claim is not a shared variable. If any caller could release it, a second provider could take
    // the document from the first by releasing on its behalf, and the rule would enforce nothing.
    expect(currentClaimHolder()).toBe('provider-a');
  });

  it('reports a claim that vanished while it was believed held', () => {
    claimDocument('provider-a');
    clearClaim();

    // Something on the page deleted it. Silently accepting that would let the next mount succeed when
    // it should not have, which is the failure this whole rule exists to prevent — arriving through
    // the rule's own state instead of through the registry.
    expect(() => releaseDocument('provider-a')).toThrowError(
      expect.objectContaining({ code: CLAIM_REFUSED.markerUnusable }) as Error,
    );
  });
});

describe('a marker that cannot be read', () => {
  it('is refused rather than overwritten when claiming', () => {
    occupyKeyWith('not a marker at all');

    expect(() => claimDocument('provider-a')).toThrowError(
      expect.objectContaining({ code: CLAIM_REFUSED.markerUnusable }) as Error,
    );

    // Not repaired, not overwritten. The key is well known by design — that is what makes the claim
    // visible across bundles — so a page script can put anything there. Overwriting would mean anyone
    // handing us a broken marker gets the claim reset, which is the same as having no rule.
    expect((document as unknown as Record<symbol, unknown>)[CLAIM_KEY]).toBe('not a marker at all');
  });

  it('is refused rather than deleted when releasing', () => {
    occupyKeyWith({ holder: 42 });

    expect(() => releaseDocument('provider-a')).toThrowError(
      expect.objectContaining({ code: CLAIM_REFUSED.markerUnusable }) as Error,
    );
    expect((document as unknown as Record<symbol, unknown>)[CLAIM_KEY]).toEqual({ holder: 42 });
  });

  it('is a different report from a provider legitimately being active', () => {
    // One means "this document already has a provider" — the rule working. The other means "the rule's
    // own state is broken". An operator acts differently on each.
    expect(CLAIM_REFUSED.markerUnusable).not.toBe(CLAIM_REFUSED.providerAlreadyActive);
  });
});

describe('a separately bundled second copy of this library', () => {
  it('sees the claim the first copy took', async () => {
    // Two module instances over one document, which is what two bundles produce. The imports are
    // deferred on purpose — they must happen after `resetModules`, which is the one case the testing
    // conventions permit an import inside a test.
    //
    // `Symbol.for` gives both copies the same key from the same string, and that is the entire
    // mechanism. A per-module `Symbol()` would leave each copy blind to the other, and a
    // micro-frontend bringing its own copy is the likeliest way two providers ever meet.
    const copyA = await import('../../../src/webmcp/claim.ts');
    vi.resetModules();
    const copyB = await import('../../../src/webmcp/claim.ts');

    expect(copyB).not.toBe(copyA);
    expect(copyB.claimDocument).not.toBe(copyA.claimDocument);

    copyA.claimDocument('copy-a-provider');

    expect(() => copyB.claimDocument('copy-b-provider')).toThrowError(
      expect.objectContaining({ code: CLAIM_REFUSED.providerAlreadyActive }) as Error,
    );
    expect(copyB.currentClaimHolder()).toBe('copy-a-provider');
  });
});
