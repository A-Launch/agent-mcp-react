import { describe, expect, it } from 'vitest';
import {
  CLAIM_REFUSED,
  fromPlatformFailure,
  isRegistryUnavailableCode,
  REGISTRATION_REFUSED,
  REGISTRY_UNAVAILABLE,
  WebMcpBoundaryError,
} from '../../../src/webmcp/errors.ts';

// The boundary's vocabulary, asserted as a closed set rather than as a list of strings someone read.
//
// A closed literal set is declared once and derived from because that is where drift becomes
// invisible: a sixth cause
// added as an inline string in one branch looks identical to a member of the set until an operator
// tries to act on it. These cases assert the properties that make the set closed, not the values it
// happens to hold today.

describe('the availability causes', () => {
  it('has five distinct members', () => {
    const codes = Object.values(REGISTRY_UNAVAILABLE);

    expect(codes).toHaveLength(5);
    expect(new Set(codes).size).toBe(5);
  });

  it('derives membership from the dictionary rather than from a second list', () => {
    // The point of the assertion: every member passes, and something shaped like a member does not.
    // A membership check written as its own list of literals would pass the first half and fail the
    // second only when the two lists drifted — which is the failure this is here to prevent.
    for (const code of Object.values(REGISTRY_UNAVAILABLE)) {
      expect(isRegistryUnavailableCode(code), code).toBe(true);
    }
    expect(isRegistryUnavailableCode('MCP_REGISTRY_SOMETHING_PLAUSIBLE')).toBe(false);
    expect(isRegistryUnavailableCode('')).toBe(false);
  });

  it('keeps the four actionable-or-unknown causes separate from each other', () => {
    // Named individually so that renaming one to match another is a failing test rather than a silent
    // loss of the distinction an operator acts on.
    expect(REGISTRY_UNAVAILABLE.insecureContext).not.toBe(REGISTRY_UNAVAILABLE.featureNotPermitted);
    expect(REGISTRY_UNAVAILABLE.hostsDiverged).not.toBe(REGISTRY_UNAVAILABLE.installationRefused);
    expect(REGISTRY_UNAVAILABLE.noDocument).not.toBe(REGISTRY_UNAVAILABLE.installationRefused);
  });
});

describe('the registration and claim vocabularies', () => {
  it('separates a duplicate this application caused from a name a foreign owner holds', () => {
    // Two different responses and two different owners. Collapsing them would tell an author to look
    // for their own second registration when the name belongs to a script they do not control.
    expect(REGISTRATION_REFUSED.nameHeldByThisApplication).not.toBe(
      REGISTRATION_REFUSED.nameHeldByForeignOwner,
    );
  });

  it('names the unusable-marker case separately from a provider already being active', () => {
    // One means "this document already has a provider", the other means "the marker cannot be trusted".
    // The first is the rule working; the second is the rule's own state being broken.
    expect(CLAIM_REFUSED.markerUnusable).not.toBe(CLAIM_REFUSED.providerAlreadyActive);
  });
});

describe('wrapping a platform failure', () => {
  it('carries the platform value as a cause and the decision in the code', () => {
    const platform = new TypeError('whatever this implementation happens to say');

    const error = fromPlatformFailure(
      REGISTRATION_REFUSED.refusedByRegistry,
      'the registry refused the registration',
      platform,
      'customers.set_filters',
    );

    expect(error).toBeInstanceOf(WebMcpBoundaryError);
    expect(error.code).toBe(REGISTRATION_REFUSED.refusedByRegistry);
    expect(error.subject).toBe('customers.set_filters');
    // The platform value is reachable for a human reading a console, and is not what any decision is
    // made from — the standard specifies one exception type here and the portability layer raises
    // another, so a decision keyed off it is right under one implementation and wrong under the other.
    expect(error.cause).toBe(platform);
  });

  it('distinguishes cases by code rather than by class', () => {
    const a = fromPlatformFailure(REGISTRY_UNAVAILABLE.insecureContext, 'a', undefined);
    const b = fromPlatformFailure(REGISTRY_UNAVAILABLE.hostsDiverged, 'b', undefined);

    // Both are the same class on purpose. `instanceof` is the test that breaks the moment two copies
    // of this library are on one page, which is a configuration this project explicitly supports.
    expect(a.constructor).toBe(b.constructor);
    expect(a.code).not.toBe(b.code);
  });
});
