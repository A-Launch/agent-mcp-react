// The boundary's failure vocabulary, and the one place a platform value is allowed to be looked at.
//
// Invariant this file enforces: **a raw platform value never leaves this module.** Not an exception
// object, not a reference to a host object, not an implementation's message. Everything crossing the
// boundary is one of the named failures below. The reason is not tidiness — the platform has two
// implementations that disagree about what they raise, so any caller that received a platform value
// would end up branching on it, and that branch would be correct under whichever implementation it was
// written against.

/**
 * Why no tool registry could be made available.
 *
 * A closed set: membership is derived from this dictionary, never re-listed as string literals
 * somewhere else. Five separate members rather than one "unavailable" because an operator can
 * fix three of these, must escalate two, and a single message hides which they are facing.
 */
export const REGISTRY_UNAVAILABLE = {
  /**
   * No document — server-side rendering. **Not an error.** The caller renders without registering and
   * without a connection; the browser phase does the rest.
   */
  noDocument: 'MCP_REGISTRY_NO_DOCUMENT',
  /**
   * The page is not a secure context, where the platform defines no registry at all.
   *
   * Checked by this module rather than by the portability layer, which has none — verified against its
   * shipped source, not its documentation. Actionable: serve over HTTPS, or use localhost, which is a
   * secure context and leaves development unaffected.
   */
  insecureContext: 'MCP_REGISTRY_INSECURE_CONTEXT',
  /**
   * An embedding document was not delegated the registry's platform feature, whose default allowlist
   * is `['self']`. Actionable by the embedder, and by nobody else.
   */
  featureNotPermitted: 'MCP_REGISTRY_FEATURE_NOT_PERMITTED',
  /**
   * Both platform host objects are present and do not resolve to the same registry.
   *
   * The standard says this cannot happen, which is exactly why it is named rather than folded into
   * the unknown cause: an operator told "installation refused" would go looking for an installation
   * problem that is not there, when what has actually broken is a guarantee this whole module rests on.
   */
  hostsDiverged: 'MCP_REGISTRY_HOSTS_DIVERGED',
  /**
   * No registry, and nothing above explains why. Unknown, and reported as unknown — never mapped onto
   * the nearest known cause to make the report look more helpful than it is.
   */
  installationRefused: 'MCP_REGISTRY_INSTALL_REFUSED',
} as const;

export type RegistryUnavailableCode =
  (typeof REGISTRY_UNAVAILABLE)[keyof typeof REGISTRY_UNAVAILABLE];

/** Membership derived from the dictionary, so a new cause cannot be half-added. */
const REGISTRY_UNAVAILABLE_CODES: ReadonlySet<string> = new Set(
  Object.values(REGISTRY_UNAVAILABLE),
);

export function isRegistryUnavailableCode(value: string): value is RegistryUnavailableCode {
  return REGISTRY_UNAVAILABLE_CODES.has(value);
}

/**
 * Why a registration was refused.
 *
 * The two duplicate cases are separate members because they need different responses and point at
 * different owners: one is this application colliding with itself, the other is a script outside this
 * library's control.
 */
export const REGISTRATION_REFUSED = {
  /** Another mounted part of this same application already registered the name. */
  nameHeldByThisApplication: 'MCP_TOOL_NAME_DUPLICATE',
  /** A script this library does not own holds the name. Not ours to shadow, rename or remove. */
  nameHeldByForeignOwner: 'MCP_TOOL_NAME_HELD_BY_FOREIGN_OWNER',
  /**
   * The name uses a prefix this library reserves for its own built-in tools — `dom.`, `runtime.`.
   *
   * **A member of THIS dictionary although nothing in this module decides it**, exactly as `churning`
   * below is. The question it answers is "why was this name not registered", an operator recognises it
   * beside the two collisions above, and it takes the reporting path a duplicate takes: development
   * throws to the author, production reports here and leaves the page standing. Put in the runtime's
   * vocabulary instead it would reach the operator's destination through the channel that cannot
   * describe it, and a production page would white-screen over a tool name.
   *
   * **What it prevents is reachability, not untidiness.** `dom.` and `runtime.` are where Level 2 and
   * Level 3 built-ins live, and a tool's level comes from the table it was found in. An application
   * registration under `dom.click` is therefore a Level 1 tool wearing a Level 2 name: an agent granted
   * `application` and denied `dom` lists it, calls it, and passes the capability gate — because the
   * gate reads the level of the table the tool came from, and that table is the application's. No later
   * check can recover the distinction; the level is right and the name is the lie.
   *
   * This says nothing about what the document CONTAINS. A foreign script may register `dom.click` and
   * this library neither prevents that nor claims otherwise — that is invariant 15's territory.
   */
  nameReserved: 'MCP_TOOL_NAME_RESERVED',
  /**
   * The registration's abort signal was already aborted when the registry was reached, so nothing was
   * registered.
   *
   * **Nothing is wrong here.** Registration is asynchronous and React's effects are not, so a
   * component that unmounts while its registration is in flight produces exactly this. It is a member
   * rather than a fold into `refusedByRegistry` because it is classifiable — from the signal's own
   * state, which is this library's, not the platform's — and "unknown" is the honest answer only when
   * nothing can be established.
   *
   * It exists because without it this condition was reported as `nameHeldByForeignOwner`: the
   * classifier asks the ownership record, an aborted registration is not in it, and the answer fell
   * through to the foreign branch. That sent an author looking for a script on the page that does not
   * exist, on every strict-mode mount.
   */
  registrationWithdrawn: 'MCP_TOOL_REGISTRATION_WITHDRAWN',
  /**
   * Not a refusal at all: a registration that has been withdrawn and re-registered implausibly often
   * without its component unmounting.
   *
   * It lives in this dictionary because it is about the registration of a name and an operator needs to
   * recognise it beside the other causes here. Nothing is rejected — every cycle the application asked
   * for happened. What is reported is the COST: one tool-list change per render, for a descriptor the
   * author is very likely computing by accident.
   */
  churning: 'MCP_TOOL_REGISTRATION_CHURNING',
  /** The registry refused for a reason this module could not classify. */
  refusedByRegistry: 'MCP_TOOL_REGISTRATION_REFUSED',
} as const;

export type RegistrationRefusedCode =
  (typeof REGISTRATION_REFUSED)[keyof typeof REGISTRATION_REFUSED];

/** Why a document claim could not be taken or released. */
export const CLAIM_REFUSED = {
  /** A provider is already active in this document. Carries the active holder. */
  providerAlreadyActive: 'MCP_REACT_PROVIDER_ALREADY_ACTIVE',
  /** A release was presented by something that is not the holder. */
  notTheHolder: 'MCP_CLAIM_NOT_THE_HOLDER',
  /**
   * The claim marker is present but cannot be made sense of, or vanished while believed held.
   *
   * The key is well known by design — that is what lets a separately bundled copy of this library see
   * the claim — which also means any page script can occupy or clear it. This is reported and never
   * repaired: silently rebuilding a marker is how a second provider gets in.
   */
  markerUnusable: 'MCP_CLAIM_MARKER_UNUSABLE',
} as const;

export type ClaimRefusedCode = (typeof CLAIM_REFUSED)[keyof typeof CLAIM_REFUSED];

export type BoundaryCode = RegistryUnavailableCode | RegistrationRefusedCode | ClaimRefusedCode;

/**
 * Every failure this module raises. One class, because a caller distinguishes cases by `code` — a
 * value from a closed set — rather than by `instanceof`, which is the test that breaks the moment two
 * copies of this library are on one page.
 */
export class WebMcpBoundaryError extends Error {
  readonly code: BoundaryCode;
  /** The tool name or claim holder the failure concerns, when it concerns one. */
  readonly subject?: string;

  constructor(
    code: BoundaryCode,
    message: string,
    options?: { subject?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WebMcpBoundaryError';
    this.code = code;
    if (options?.subject !== undefined) this.subject = options.subject;
  }
}

/**
 * Wraps a value thrown by the platform.
 *
 * The platform value is attached as `cause` and is **never** consulted to decide what happened. The
 * standard specifies an `InvalidStateError` DOMException for a duplicate name and the portability
 * layer raises a plain `Error`, identically on every engine tested; anything keyed off the class, the
 * `name` or the message works under one implementation and fails under the other, silently, in a
 * browser channel nobody ran.
 *
 * The `cause` exists so a developer looking at a console can see what the platform said. Nothing in
 * this library reads it.
 */
export function fromPlatformFailure(
  code: BoundaryCode,
  message: string,
  cause: unknown,
  subject?: string,
): WebMcpBoundaryError {
  return new WebMcpBoundaryError(code, message, {
    cause,
    ...(subject === undefined ? {} : { subject }),
  });
}
