// The closed sets the capability model is made of.
//
// Six dictionaries and one naming table, in one file, because they are read together at every
// decision and because membership must be derived from the dictionary rather than re-listed as string
// literals somewhere else (CONTRIBUTING.md#9-forbidden-patterns). A caller matches against a member;
// nothing anywhere spells one.
//
// **What this file is not.** It holds no decision. `resolve.ts` decides, and the runtime enforces —
// a module that both names the values and judges them is one whose vocabulary drifts to fit whatever
// the judging needed that week.

/**
 * The three levels of control, which are what a capability admits
 * (docs/reference-capabilities.md#the-three-levels). They are separate layers, and one confers nothing
 * on another.
 *
 * A level is decided by **which table a tool came from**, never by its name. Level 1 tools arrive
 * through the document's registry because an application registered them; Levels 2 and 3 are a closed
 * build-time set this library ships and never registers. The reserved prefixes below are a collision
 * guard so the two namespaces cannot be confused by a reader — they are not the boundary.
 */
export const CONTROL_LEVEL = {
  /** `customers.set_filters` — the same action the human UI calls. The reason the library exists. */
  application: 1,
  /** `dom.snapshot`, `dom.click` — roles and accessible names, for flows nobody instrumented. */
  dom: 2,
  /** `runtime.evaluate` — privileged, debug-only, and never enabled to unblock a task. */
  evaluate: 3,
} as const;

export type ControlLevel = (typeof CONTROL_LEVEL)[keyof typeof CONTROL_LEVEL];

/**
 * The two halves of the DOM capability — the authorities a Level 2 tool can need.
 *
 * A closed set rather than an inline union, because three places have to agree about it: the
 * capability shape above, the normalizer that refuses an unknown half, and the decision that admits a
 * tool under one half or the other. A union spelled at each site is a set that drifts.
 */
export const DOM_AUTHORITY = {
  /** Reading the page — `dom.snapshot`. */
  inspect: 'inspect',
  /** Acting on it — `dom.click`, `dom.fill`. Never implied by `inspect`. */
  interact: 'interact',
} as const;

export type DomAuthority = (typeof DOM_AUTHORITY)[keyof typeof DOM_AUTHORITY];

const DOM_AUTHORITIES: ReadonlySet<string> = new Set(Object.values(DOM_AUTHORITY));

export function isDomAuthority(value: string): value is DomAuthority {
  return DOM_AUTHORITIES.has(value);
}

/**
 * What a bridged connection may reach.
 *
 * **Every member is required**, and that is the point: an omitted capability would be a value nobody
 * wrote, and absent is denied rather than defaulted, because authority only narrows. The provider
 * takes this whole, so an application states what its agent may reach rather than accepting a profile
 * it never read.
 *
 * `dom` is a pair rather than a boolean because reading the page and acting on it are different
 * authorities — the read-only profile is exactly `inspect: true, interact: false`
 * (docs/reference-capabilities.md#the-shape).
 */
export interface AgentCapabilities {
  /**
   * Level 1. Refusing it refuses bridged calls; it does NOT unregister anything — a capability governs
   * this library's bridge and not the page, so a registered tool stays callable by any page script
   * (docs/explanation-reachability.md#a-capability-governs-the-bridge-not-your-page).
   */
  readonly application: boolean;
  /**
   * Level 2, split by authority.
   *
   * **Derived from `DOM_AUTHORITY` rather than re-listing its members**, so a third authority cannot
   * be added to the dictionary and silently omitted here — the shape would stop compiling, which is
   * the point of deriving membership from the dictionary rather than re-listing it.
   */
  readonly dom: Readonly<Record<DomAuthority, boolean>>;
  readonly evaluate: boolean;
}

/** The capability member names, so an unknown one can be refused rather than ignored. */
export const CAPABILITY_MEMBER = {
  application: 'application',
  dom: 'dom',
  evaluate: 'evaluate',
} as const;

export type CapabilityMember = (typeof CAPABILITY_MEMBER)[keyof typeof CAPABILITY_MEMBER];

const CAPABILITY_MEMBERS: ReadonlySet<string> = new Set(Object.values(CAPABILITY_MEMBER));

export function isCapabilityMember(value: string): value is CapabilityMember {
  return CAPABILITY_MEMBERS.has(value);
}

/**
 * Which capability member admits each control level.
 *
 * Derived from both dictionaries rather than written out, so a level added without a member — or a
 * member renamed — is a compile error rather than a lookup that quietly returns nothing and a refusal
 * that stops naming what an operator would have to grant.
 *
 * It is a naming table and **not** the gate: nothing here decides anything, and a level absent from it
 * is refused by the decision above rather than admitted for want of an entry.
 */
export const LEVEL_CAPABILITY: Readonly<Record<ControlLevel, CapabilityMember>> = {
  [CONTROL_LEVEL.application]: CAPABILITY_MEMBER.application,
  [CONTROL_LEVEL.dom]: CAPABILITY_MEMBER.dom,
  [CONTROL_LEVEL.evaluate]: CAPABILITY_MEMBER.evaluate,
};

/**
 * What a tool says about itself (docs/reference-capabilities.md#per-tool-permissions).
 *
 * **`risk` enforces nothing on its own, and that is a decision rather than an omission.** It is
 * advertised and it is what an operator, an observer or a later policy surface reads; enforcement
 * comes from `available` and `confirmation`. Without this rule two implementations could both claim
 * compliance — one treating `destructive` as implying confirmation and one not — and the gate chain's
 * `policy` step would be concealing a field that does nothing.
 */
export const RISK = {
  read: 'read',
  write: 'write',
  destructive: 'destructive',
  privileged: 'privileged',
} as const;

export type Risk = (typeof RISK)[keyof typeof RISK];

const RISKS: ReadonlySet<string> = new Set(Object.values(RISK));

export function isRisk(value: string): value is Risk {
  return RISKS.has(value);
}

/**
 * Namespaces an application may not declare into (docs/design.md#tool-names).
 *
 * A **collision guard**, not the level boundary. Without it an application tool could shadow a gated
 * built-in and the agent's list would be ambiguous about which source a name came from. With it, the
 * two namespaces stay legible — but a tool's level still comes from the table it was found in, so a
 * mistake here cannot promote anything.
 */
export const RESERVED_PREFIX = {
  dom: 'dom.',
  runtime: 'runtime.',
} as const;

export type ReservedPrefix = (typeof RESERVED_PREFIX)[keyof typeof RESERVED_PREFIX];

const RESERVED_PREFIXES: readonly ReservedPrefix[] = Object.values(RESERVED_PREFIX);

/**
 * The reserved prefix a name uses, or nothing.
 *
 * A prefix, not a substring: `domain.set_filters` is an application's to declare and always was.
 */
export function reservedPrefixOf(name: string): ReservedPrefix | undefined {
  return RESERVED_PREFIXES.find((prefix) => name.startsWith(prefix));
}

/**
 * What an operator answered when asked to confirm a call.
 *
 * **A closed set, and that is the whole reason it exists rather than a boolean.** The design requires
 * that "the resolver returned something that is not a decision" be a determinate test rather than a
 * phrase — and it is a real case: a resolver is application code, it can return `undefined` from a
 * dialog that was dismissed, `true` from an author who assumed a boolean, or a promise that resolves
 * to nothing. Every one of those denies, and none of them can be mistaken for an approval by a check
 * that asks "is it truthy".
 */
export const CONFIRMATION = {
  approved: 'approved',
  refused: 'refused',
} as const;

export type ConfirmationDecision = (typeof CONFIRMATION)[keyof typeof CONFIRMATION];

const CONFIRMATION_DECISIONS: ReadonlySet<unknown> = new Set(Object.values(CONFIRMATION));

/**
 * Whether a value is a decision.
 *
 * Takes `unknown` rather than `string`, because what it guards is the return of application code and
 * narrowing the parameter would move the failure to a cast at the call site — where it would be
 * spelled by whoever was in a hurry.
 */
export function isConfirmationDecision(value: unknown): value is ConfirmationDecision {
  return CONFIRMATION_DECISIONS.has(value);
}

/**
 * What a resolver is shown when a call needs approval.
 *
 * Everything here is what the LIBRARY knows about the call. It carries no connection identity, no
 * ticket and no capability set: a confirmation surface is for a person deciding about an action, and
 * a credential in the object handed to a dialog is a credential in a screenshot.
 */
export interface ConfirmationRequest {
  /** The tool's name, as the agent named it and as the listing published it. */
  readonly tool: string;
  /** The tool's declared title, when it has one — what a person should see rather than the name. */
  readonly title?: string;
  readonly description: string;
  /**
   * The call's arguments, **already validated**, as a detached and deeply frozen snapshot.
   *
   * Detached so that whatever a resolver does to it cannot reach the handler, and deeply frozen so
   * that a resolver cannot change what it is showing a person between the render and the answer. A
   * shallow freeze would leave every nested value writable — a person approves one thing and another
   * runs, which is the whole failure this snapshot exists to prevent.
   */
  readonly arguments: Readonly<Record<string, unknown>>;
  /**
   * Aborts when the call is cancelled or the tool stops being declared.
   *
   * A dialog that is still open for a call nobody is waiting for should close itself. The runtime does
   * not need the resolver to cooperate — the confirmation is raced against this same cancellation — but
   * a surface that leaves a stale prompt on screen is a surface that gets approved by mistake later.
   */
  readonly signal: AbortSignal;
}

/**
 * What an application supplies to answer a confirmation.
 *
 * It is called **once per call**, and its promise settles once, so a decision cannot be replayed onto
 * another call and cannot be answered twice — those are structural properties of this shape rather
 * than rules something has to enforce.
 *
 * A resolver that never settles leaves the call pending until it is cancelled, and that is deliberate:
 * a confirmation is human-scale, so a timeout would be a policy this library invented on an operator's
 * behalf. The call still always produces an outcome, because it is raced against its cancellation.
 */
export type ConfirmationResolver = (
  request: ConfirmationRequest,
) => ConfirmationDecision | Promise<ConfirmationDecision>;

/**
 * Why a gate refused.
 *
 * Distinct from the runtime's failure vocabulary on purpose: this names the DECISION, and the runtime
 * maps a decision onto what the agent is told. Keeping them apart is what lets a decision be made and
 * asserted without a protocol layer anywhere near it.
 */
export const REFUSED_BECAUSE = {
  /** The tool's control level is not admitted by this connection's capability set. */
  capabilityDenied: 'capabilityDenied',
  /** The tool is currently declared unavailable by the application. */
  unavailable: 'unavailable',
  /** The tool requires confirmation and no resolver was supplied to give one. */
  noConfirmationResolver: 'noConfirmationResolver',
  /** The confirmation was refused, or the resolver failed to produce a decision. */
  confirmationRefused: 'confirmationRefused',
} as const;

export type RefusedBecause = (typeof REFUSED_BECAUSE)[keyof typeof REFUSED_BECAUSE];
