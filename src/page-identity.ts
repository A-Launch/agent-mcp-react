// The identity of one browser page instance, and the only place this library names the platform's
// source of unique values.
//
// It exists as its own module — outside every concern directory — for the same reason
// `src/build-mode.ts` does: the fact belongs to none of them. It is not the tool registry, not the
// socket, not the runtime, and it decides nothing. `src/react/` publishes it to the application
// through a hook; nothing else in `src/**` reads it.
//
// **Why it is not in `src/react/`.** A page instance is a document-scoped fact, not a React-scoped
// one, and the platform's unique-value source must be named in exactly one place. Named inside the
// React binding, a future non-React binding would either duplicate the mint or import React's
// directory — two owners of one truth. A row in the module-seam suite enforces that this is the only
// file that names it.
//
// **What the identity is for, and what it is emphatically not.** An agent runtime holds connections
// from several pages and must be able to say which one it means. That is addressing, and this value is
// metadata: safe to log, safe to render, safe to put in a URL. It is NEVER a credential and NEVER
// evidence of anything — holding it grants nothing, and no capability, policy decision or tool
// admission may consult it (docs/design.md#page-identity), and reading one as a credential is a
// forbidden pattern in its own right (CONTRIBUTING.md#9-forbidden-patterns). The library publishes it
// and stops; the application attaches it to the connection URL it supplies, because the transport is
// forbidden to amend a URL and the URL supplier's signature must not grow a parameter.
//
// **Why the value is minted on first READ rather than at a lifecycle moment.** An application needs
// the identity while it is building a connection URL, which can be during render. Minting in an effect
// would mean there is a window in which a page instance has no identity — and every consumer would
// carry an absent case, with the one that forgets appending a placeholder to a URL and misidentifying
// the page. Minting on read removes the window instead of documenting it.

/**
 * The key the identity lives under, on the document.
 *
 * `Symbol.for` rather than `Symbol()`, and the reason is the same one `src/webmcp/claim.ts` records
 * for the provider claim: a separately bundled second copy of this library computes the same symbol
 * from the same string and therefore sees the first copy's identity. A unique per-module symbol would
 * be invisible across bundles, and the case that matters — a micro-frontend that brings its own copy —
 * would mint a second identity for one page. An agent would then see two tabs where a person sees one
 * page, which is precisely the confusion this value exists to prevent.
 *
 * The accepted cost is the same too: a well-known key is observable and occupiable by any script on
 * the page. That is handled by refusing loudly on a value that cannot be made sense of, never by
 * repairing one — silently rebuilding a marker is how a second identity gets in.
 */
const IDENTITY_KEY = Symbol.for('agent-mcp-react.page-instance-identity');

/**
 * Why a page instance has no identity to give.
 *
 * A closed set: membership is derived from this dictionary, never re-listed as string literals
 * somewhere else. Two members rather than one, because they point at different people — the
 * first is normal and needs no action, the second is an operator's to fix.
 *
 * **These are deliberately NOT members of the registry's vocabulary**, although one of the two
 * conditions is identical. That dictionary answers "why could no tool registry be made available", and
 * every one of its messages says so. An identity mint that failed with a registry cause would send a
 * reader looking for a registry problem that is not there — the same misdiagnosis that dictionary's own
 * comments warn against. One condition, two questions, two answers.
 */
export const IDENTITY_UNAVAILABLE = {
  /**
   * No document — server-side rendering.
   *
   * **Not a defect, and not something to work around.** An identity names a browser page instance, so
   * a server render has nothing to name. The library itself never reads an identity while rendering:
   * it needs one only when the application dials, which happens in an effect. An application that
   * reaches for one during a server render is asking for something that does not exist there, and is
   * told so rather than handed a value that would flow into a URL and identify the wrong thing.
   */
  noDocument: 'MCP_PAGE_IDENTITY_NO_DOCUMENT',
  /**
   * The platform offers no cryptographic source of unique values.
   *
   * In practice: a page served over plain HTTP from a non-localhost address, which is the usual way to
   * meet this — testing on a phone against a laptop's dev server. Actionable: serve over HTTPS, or use
   * localhost, which is a secure context and leaves development unaffected.
   *
   * There is deliberately no weaker fallback. A counter or a timestamp would make two page instances
   * look like one, and a duplicate identity fails in the direction that reads as success — an agent
   * addresses one page and reaches another, and every result looks normal.
   */
  noUniqueSource: 'MCP_PAGE_IDENTITY_NO_UNIQUE_SOURCE',
  /**
   * Something is under this library's key that it did not put there, or can no longer read.
   *
   * Refused rather than overwritten. Overwriting would mean any script on the page could hand this
   * library a broken value and have the identity silently reissued, which is the same outcome as
   * having no rule at all.
   */
  markerUnusable: 'MCP_PAGE_IDENTITY_MARKER_UNUSABLE',
} as const;

export type IdentityUnavailableCode =
  (typeof IDENTITY_UNAVAILABLE)[keyof typeof IDENTITY_UNAVAILABLE];

/** Membership derived from the dictionary, so a new cause cannot be half-added. */
const IDENTITY_UNAVAILABLE_CODES: ReadonlySet<string> = new Set(
  Object.values(IDENTITY_UNAVAILABLE),
);

export function isIdentityUnavailableCode(value: string): value is IdentityUnavailableCode {
  return IDENTITY_UNAVAILABLE_CODES.has(value);
}

/**
 * Raised when a page instance has no identity to give.
 *
 * Carries a code from the closed set above and never a platform value: an implementation's own
 * exception would make every caller branch on whatever that implementation happened to raise.
 */
export class PageIdentityError extends Error {
  readonly code: IdentityUnavailableCode;

  constructor(code: IdentityUnavailableCode, message: string) {
    super(message);
    this.name = 'PageIdentityError';
    this.code = code;
  }
}

/** What the document holds. Kept minimal: this is not a place to keep anything else. */
interface IdentityMarker {
  readonly id: string;
}

type IdentityHost = { [IDENTITY_KEY]?: unknown };

/** Whether a value found under the key is a marker this library can act on. */
function isIdentityMarker(value: unknown): value is IdentityMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id !== ''
  );
}

/**
 * The identity of this page instance, minting one if this is the first read.
 *
 * Stable for the document's lifetime: every later call returns the same value, across rerenders, route
 * changes, provider remounts and a development-mode double invocation. A reload is a different page
 * instance and gets a different identity — which is why nothing here persists. A persisted value would
 * identify a browsing context across page instances, so two restored tabs would share one, and that is
 * the failure this exists to prevent rather than a feature.
 *
 * Throws rather than returning a fallback when there is no page instance to name, or no source to mint
 * from. A caller that wants to tolerate that catches it; nothing here decides on its behalf.
 */
export function pageInstanceId(): string {
  // No document at all — a server render. Checked first, because it is the ordinary case of the three
  // and the only one that is not a problem.
  if (typeof document === 'undefined') {
    throw new PageIdentityError(
      IDENTITY_UNAVAILABLE.noDocument,
      'there is no document, so there is no page instance to identify — a page identity is minted in the browser, and the library needs one only when it dials',
    );
  }

  // **Presence, not value.** `host[IDENTITY_KEY] !== undefined` treats a property somebody else
  // defined AS `undefined` as absent — and the next step would then either overwrite their property
  // or, if they made it non-configurable, throw a raw `TypeError` that no caller can classify. Both
  // are the silent repair this refuses to do.
  if (Object.hasOwn(document, IDENTITY_KEY)) {
    const existing = (document as unknown as IdentityHost)[IDENTITY_KEY];
    if (!isIdentityMarker(existing)) {
      throw new PageIdentityError(
        IDENTITY_UNAVAILABLE.markerUnusable,
        'this page instance carries an identity marker that cannot be read — something else on the page is using this key, and it will not be overwritten',
      );
    }
    return existing.id;
  }

  const marker: IdentityMarker = { id: mint() };
  // Non-enumerable so it does not appear in an enumeration of the document, and `configurable` so a
  // test can remove it to simulate a fresh page instance. NOT writable: the value is not something to
  // reassign, and uniqueness is the whole point of it.
  Object.defineProperty(document, IDENTITY_KEY, {
    value: marker,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return marker.id;
}

/**
 * Produces one unique value, or refuses.
 *
 * **The only place in `src/**` that names the platform's unique-value source**, enforced by a row in
 * the module-seam suite. That is the mechanism rather than a request: a second site would be a second
 * chance to add a fallback, and a fallback here is indistinguishable from success.
 *
 * Read through `globalThis` rather than as a bare global, because the property is absent rather than
 * throwing in the environments that lack it, and an optional call is then a check rather than a
 * `typeof` dance.
 */
function mint(): string {
  const source = globalThis.crypto as { randomUUID?: unknown } | undefined;
  const generate = source?.randomUUID;
  // **Checked for callability, not merely for presence.** An optional call guards `null` and
  // `undefined` and nothing else, so a malformed or legacy polyfill exposing `randomUUID` as anything
  // other than a function would throw a raw `TypeError` — an unclassified failure, which is the one
  // outcome this module exists to never produce.
  const value = typeof generate === 'function' ? (generate.call(source) as unknown) : undefined;
  // `=== 'string'` and non-empty rather than truthiness: an implementation that returned something
  // else is a broken source, and a broken source must not be treated as a working one.
  if (typeof value !== 'string' || value === '') {
    throw new PageIdentityError(
      IDENTITY_UNAVAILABLE.noUniqueSource,
      globalThis.isSecureContext === false
        ? 'this page is not a secure context, where the platform offers no cryptographic source of unique values — serve it over HTTPS, or use localhost'
        : 'this environment offers no cryptographic source of unique values, so no page identity can be minted — no weaker source is substituted, because two pages that shared an identity would look like one',
    );
  }
  return value;
}
