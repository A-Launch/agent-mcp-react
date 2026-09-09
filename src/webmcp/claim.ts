import { CLAIM_REFUSED, WebMcpBoundaryError } from './errors.ts';

// The document provider claim: one active provider per document, and a loud failure when a second
// one mounts.
//
// It lives in this module rather than in `src/react/` because what is being claimed is document-scoped
// ownership of the registry — the same scope, the same document, the same lifetime. `src/react/` calls
// `claimDocument()` in the provider's mount effect and `releaseDocument()` in its cleanup, and touches
// no document itself.
//
// The reason the rule exists at all: the registry belongs to the document, not to the provider. Two
// providers would keep two ownership records over one registry, each would classify the other's
// registrations as foreign, and every resulting symptom would be the specified rules working
// correctly while pointing the reader at "some other script on the page" — when the cause is "this
// application mounted two providers."

/**
 * The key the claim lives under.
 *
 * `Symbol.for` rather than `Symbol()`, deliberately: a separately bundled second copy of this library
 * computes the same symbol from the same string, which is what lets it see the first copy's claim. A
 * unique per-module symbol would be invisible across bundles, and the case this rule exists for — a
 * micro-frontend that brings its own copy — is exactly the case that would then go undetected.
 *
 * The accepted cost: a well-known key is observable, occupiable and clearable by any script on the
 * page. That is handled by refusing loudly on a marker that cannot be made sense of, never by
 * repairing one. Rebuilding a marker silently is how a second provider gets in.
 */
const CLAIM_KEY = Symbol.for('agent-mcp-react.document-provider-claim');

/** What the marker holds. Kept minimal: this is not a place to keep provider state. */
interface ClaimMarker {
  readonly holder: string;
}

type ClaimHost = { [CLAIM_KEY]?: unknown };

/** Whether a value found under the key is a marker this library can act on. */
function isClaimMarker(value: unknown): value is ClaimMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { holder?: unknown }).holder === 'string'
  );
}

/**
 * Claims the document for one provider.
 *
 * Throws when the document is already claimed, naming the active holder — never deferring, never
 * sharing, and never taking the claim over. A provider that unmounts and mounts again succeeds,
 * because the release removes the marker: a route change, a hot reload and a double-invoked effect all
 * work.
 */
export function claimDocument(holder: string): void {
  const host = document as unknown as ClaimHost;
  const existing = host[CLAIM_KEY];

  if (existing !== undefined) {
    if (!isClaimMarker(existing)) {
      // Something is under our key that we did not put there, or that we can no longer read. It is not
      // repaired and not overwritten: overwriting would mean a page script could hand us a broken
      // marker and get the claim reset, which is the same outcome as having no rule at all.
      throw new WebMcpBoundaryError(
        CLAIM_REFUSED.markerUnusable,
        'the document provider claim is present but cannot be read — something else on the page is using this key, and it will not be overwritten',
      );
    }
    throw new WebMcpBoundaryError(
      CLAIM_REFUSED.providerAlreadyActive,
      `a provider is already active in this document (held by "${existing.holder}") — the tool registry belongs to the document, so it can have only one`,
      { subject: existing.holder },
    );
  }

  const marker: ClaimMarker = { holder };
  Object.defineProperty(document, CLAIM_KEY, {
    value: marker,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

/**
 * Releases the claim, and only to the holder that took it.
 *
 * A release presented by anything else is refused. The claim is not a shared variable: if any caller
 * could release it, a second provider could take the document from the first by releasing on its
 * behalf, and the rule would enforce nothing.
 */
export function releaseDocument(holder: string): void {
  const host = document as unknown as ClaimHost;
  const existing = host[CLAIM_KEY];

  if (existing === undefined) {
    // Believed held and gone. Reported rather than shrugged off: the marker vanishing under a live
    // provider means something on the page is deleting it, and the next mount will succeed when it
    // should not have.
    throw new WebMcpBoundaryError(
      CLAIM_REFUSED.markerUnusable,
      `the document provider claim held by "${holder}" is gone — something removed it while the provider was still active`,
      { subject: holder },
    );
  }

  if (!isClaimMarker(existing)) {
    throw new WebMcpBoundaryError(
      CLAIM_REFUSED.markerUnusable,
      'the document provider claim is present but cannot be read, so it will not be released',
    );
  }

  if (existing.holder !== holder) {
    throw new WebMcpBoundaryError(
      CLAIM_REFUSED.notTheHolder,
      `the document provider claim is held by "${existing.holder}" and cannot be released by "${holder}"`,
      { subject: existing.holder },
    );
  }

  Reflect.deleteProperty(document as object, CLAIM_KEY);
}

/** Who holds the claim, if anyone. For diagnostics and conformance cases; no behaviour reads it. */
export function currentClaimHolder(): string | undefined {
  const existing = (document as unknown as ClaimHost)[CLAIM_KEY];
  return isClaimMarker(existing) ? existing.holder : undefined;
}
