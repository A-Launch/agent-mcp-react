import type { ModelContext } from '@mcp-b/webmcp-types';
import {
  fromRegistryEntry,
  type RegistryEntry,
  type ToolDeclaration,
  toDescriptor,
} from './descriptor.ts';
import {
  fromPlatformFailure,
  REGISTRATION_REFUSED,
  REGISTRY_UNAVAILABLE,
  WebMcpBoundaryError,
} from './errors.ts';

// The only code in this package that names either platform host object.
//
// A reference to `document.modelContext` or `navigator.modelContext` anywhere else is a boundary
// violation of the same class as a `WebSocket` outside `src/transport/`, and `tests/unit/webmcp/
// boundary.spec.ts` fails when one appears. The reason is not neatness: the standard is a draft whose
// host object has already moved once, and a revision must be absorbable by editing this directory
// alone. One module reaching past the boundary "just for this field" is invisible until the next
// revision, when a one-directory edit turns out to be a repository-wide one.
//
// This module imports no React, opens no socket, and decides no policy. It reports what the registry
// did; `src/security/` decides what may happen.

/** The document's registry, plus how it got there. */
export interface ResolvedRegistry {
  readonly registry: ModelContext;
  /**
   * Whether the registry was already present or installed by this module.
   *
   * For diagnostics and conformance cases only. **No behaviour branches on it** — a caller that could
   * act differently on an installed registry would be writing the conditional this module exists to
   * remove.
   */
  readonly provenance: 'present' | 'installed';
}

/**
 * A host object as it actually is, rather than as the platform's type declarations describe it.
 *
 * Those declarations augment `Document` and `Navigator` with a non-optional `modelContext`, which is
 * true of a browser that implements the standard and false of every browser that does not — and
 * detecting that absence is this module's first job. Modelling it as optional here is a narrowing of
 * an over-promise, not a claim about data received from outside.
 */
interface MaybeRegistryHost {
  modelContext?: ModelContext;
}

/** Reads a host object without asserting the registry is there. */
function readHost(host: MaybeRegistryHost | undefined): ModelContext | undefined {
  return host?.modelContext;
}

/** Resolution memo, so a second call returns the same registry and installs nothing. */
let resolved: ResolvedRegistry | undefined;

/**
 * Resolves the tool registry for this document, or throws a **named** failure.
 *
 * MUST be called from an effect, never at module scope: at module scope it would run during
 * server-side rendering, and it is the moment a page acquires a registry, which belongs to the
 * provider's lifecycle rather than to whoever imported this file.
 *
 * There is no degraded mode. When no registry can be made available this throws and returns nothing —
 * an empty tool set presented as a working state is the defect this project exists to avoid, because
 * it looks exactly like an application that instrumented nothing.
 */
export async function ensureRegistry(): Promise<ResolvedRegistry> {
  if (resolved !== undefined) return resolved;

  if (typeof document === 'undefined') {
    // Not an error. Rendering on a server is a supported state; it simply has no document to hold a
    // registry, and the browser phase does the rest (docs/design.md#the-provider).
    throw new WebMcpBoundaryError(
      REGISTRY_UNAVAILABLE.noDocument,
      'there is no document, so there is no tool registry — this is server-side rendering, not a failure',
    );
  }

  // Both host objects are read here, before anything is installed, because divergence is a property of
  // the environment as found. Reading them afterwards would mean reading an alias this module just
  // installed — which, on the portability layer, emits a deprecation warning about a host object the
  // application never touched. A library that makes a browser console complain about its own internals
  // is a library reporting on itself.
  const onDocument = readHost(document);
  const onNavigator = readHost(globalThis.navigator);

  if (onDocument !== undefined && onNavigator !== undefined && onDocument !== onNavigator) {
    // The standard says the deprecated host object resolves to the same instance wherever it exists,
    // so reaching here means that guarantee is broken. Reported as itself rather than as the unknown
    // cause: an operator told "installation refused" would look for an installation problem that is
    // not there, when what has failed is an assumption this entire module rests on.
    throw new WebMcpBoundaryError(
      REGISTRY_UNAVAILABLE.hostsDiverged,
      'the document and the deprecated host object resolve to different tool registries, which the standard says cannot happen',
    );
  }

  const alreadyPresent = onDocument ?? onNavigator;
  if (alreadyPresent !== undefined) {
    // A registry that is already here is used **unchanged**. Wrapping or proxying it would make the
    // wrapper the authority and the platform's registry a mirror — the inversion this project rejected
    // two adjacent runtimes for.
    resolved = { registry: alreadyPresent, provenance: 'present' };
    return resolved;
  }

  // The platform defines the registry only in a secure context, so a native implementation will never
  // be here on an insecure origin. The portability layer does NOT check this — verified against its
  // shipped source — so the check lives here. Installing a stand-in where the platform provides
  // nothing manufactures an environment that exists nowhere else, and the failure then surfaces later
  // and somewhere confusing. `localhost` is a secure context, so development is unaffected.
  //
  // The condition is `!== true` rather than `=== false` deliberately. An environment that does not
  // report at all cannot tell us we are in a secure context, and proceeding on that silence would be
  // an assumption wearing a check's clothing. Every browser has reported this for years, so
  // the absent case is a test harness or an engine far below the support floor — and a test that wants
  // this path open says so, rather than benefiting from an omission.
  if (globalThis.isSecureContext !== true) {
    throw new WebMcpBoundaryError(
      REGISTRY_UNAVAILABLE.insecureContext,
      globalThis.isSecureContext === false
        ? 'the page is not a secure context, where the tool registry is not defined — serve it over HTTPS, or use localhost'
        : 'this environment does not report whether it is a secure context, and the tool registry is defined only in one',
    );
  }

  const denied = featureExplicitlyDenied();
  if (denied) {
    throw new WebMcpBoundaryError(
      REGISTRY_UNAVAILABLE.featureNotPermitted,
      'this document was not delegated the tool-registry platform feature, whose default allowlist is ["self"] — the embedder must delegate it',
    );
  }

  await installPortabilityLayer();

  const installed = readHost(document) ?? readHost(globalThis.navigator);
  if (installed === undefined) {
    throw new WebMcpBoundaryError(
      REGISTRY_UNAVAILABLE.installationRefused,
      'no tool registry is present and installing one did not produce a registry, for a reason this boundary cannot explain',
    );
  }

  // The postcondition this module owns: exactly one registry, reachable at the canonical location.
  // The portability layer already declines to install over an existing registry, and duplicating that
  // rule here would create a second owner of it — so the outcome is asserted and the rule is not
  // re-implemented here.
  if (readHost(document) === undefined) {
    throw new WebMcpBoundaryError(
      REGISTRY_UNAVAILABLE.installationRefused,
      'a tool registry was installed but is not reachable at the canonical location',
    );
  }

  resolved = { registry: installed, provenance: 'installed' };
  return resolved;
}

/**
 * Initializes the portability layer, having first turned off its own initialization.
 *
 * The import is **dynamic**, and that is load-bearing. The layer initializes itself when its module
 * evaluates unless a global says otherwise, and a static ESM import is hoisted — so the option could
 * never be set in time from inside this file. Two things depend on getting this right:
 *
 *   - resolution must happen when the provider asks, not when someone imports this library;
 *   - otherwise merely shipping this code installs a registry, a deprecated host alias and a testing
 *     surface into every document that loads it, including a build that never mounts a provider.
 *
 * `installTestingShim: false` for the same reason at one level down: a testing surface on a production
 * page is reachable surface nobody asked for.
 */
async function installPortabilityLayer(): Promise<void> {
  const host = globalThis as typeof globalThis & {
    __webMCPPolyfillOptions?: { autoInitialize?: boolean };
  };
  host.__webMCPPolyfillOptions = { autoInitialize: false };

  const layer = await import('@mcp-b/webmcp-polyfill');
  layer.initializeWebMCPPolyfill({ autoInitialize: false, installTestingShim: false });
}

/**
 * The platform feature name the registry is gated behind (docs/browser-support.md).
 *
 * Recorded as a constant rather than inlined because it is a fact about the standard, and the standard
 * is a draft — if the name changes, this is the line that changes.
 */
const REGISTRY_POLICY_FEATURE = 'tools';

/**
 * Whether the browser has told us this document is denied the registry's platform feature.
 *
 * **This answers only when the browser can answer.** The query surface exists in one engine family and
 * is absent elsewhere, and a browser that does not know the feature name at all cannot say anything
 * about it. Both of those return `false` here — meaning "not explicitly denied", never "permitted".
 *
 * The guard matters more than the check. Reporting `featureNotPermitted` because we could not find a
 * query surface would be exactly the mapping of an unknown onto a known cause that this vocabulary
 * exists to prevent: an operator would go delegate a policy that was never the problem. When the
 * browser cannot tell us, the honest outcome is the unknown cause.
 *
 * Consequently this cause is **unreachable in every engine that lacks the query surface**, which is
 * most of them today. That is recorded in the conformance claims rather than papered over.
 */
function featureExplicitlyDenied(): boolean {
  const policy = (document as unknown as { featurePolicy?: FeaturePolicyLike }).featurePolicy;
  if (policy === undefined) return false;
  if (typeof policy.features !== 'function' || typeof policy.allowsFeature !== 'function') {
    return false;
  }
  // A browser that does not list the feature does not have an opinion about it — asking anyway would
  // get `false` back and be read as a denial.
  if (!policy.features().includes(REGISTRY_POLICY_FEATURE)) return false;
  return policy.allowsFeature(REGISTRY_POLICY_FEATURE) === false;
}

/** The shape of the non-standard policy-query surface, where a browser offers one. */
interface FeaturePolicyLike {
  features(): string[];
  allowsFeature(feature: string): boolean;
}

/**
 * Registers one tool, and reports a refusal as this project's own named failure.
 *
 * `ownership` answers "did we register this name?" and is what a duplicate is classified from. This
 * module keeps no ownership record of its own — asking it whether a name is ours is asking the wrong
 * module, and a second record of one truth is how the two drift.
 */
export async function register(
  declaration: ToolDeclaration,
  signal: AbortSignal,
  ownership: { holds(name: string): boolean },
): Promise<void> {
  const { registry } = await ensureRegistry();

  try {
    // `try { await ... }` and **never** a trailing `.catch()`, because a refusal can arrive on either
    // channel and this form is the only one that catches both.
    //
    // **The two channels, and they differ between the standard and the implementation this project
    // resolves** — established by reading the pinned normative text rather than either one's
    // documentation (`tests/conformance/evidence/webmcp-41d12f0.bs`):
    //
    //   an already-aborted signal    rejects                      — both
    //   a duplicate name             REJECTS with InvalidStateError — the STANDARD
    //   a duplicate name             THROWS synchronously          — the RESOLVED PACKAGE
    //
    // `registerTool(...).catch(fn)` sees a rejection and lets a synchronous throw escape as an
    // uncaught exception — the loud failure arriving somewhere nobody is listening. So `.catch()`
    // would be **correct against the standard and broken against the package actually running here**,
    // which is exactly the refactor this comment exists to prevent. Do not "simplify" it.
    //
    // Both channels are pinned by `tests/conformance/registry-duplicate-timing.spec.ts`.
    await registry.registerTool(toDescriptor(declaration), { signal });
  } catch (cause) {
    throw classifyRegistrationFailure(declaration.name, cause, signal, ownership);
  }
}

/**
 * Withdraws one registration and registers a replacement, as **one** change the registry reports once.
 *
 * Invariant this function enforces: **the registry is resolved BEFORE the withdrawal, and the
 * withdrawal and the registration happen in one turn with nothing awaited between them.**
 *
 * The platform coalesces mutations onto a microtask. Measured: `abort()` followed by
 * `await register(...)` produces TWO change events, because `register` awaits registry resolution first
 * and the withdrawal's event is delivered while it does. The same pair with nothing awaited between
 * them produces ONE, and the new descriptor wins.
 *
 * What the extra event costs is not noise. The design requires one `tools/list_changed` per descriptor
 * change (docs/design.md#stable-handlers); two means an agent is told twice, and in the window between
 * them the tool is absent from the list and a call against it is refused — the storm that rule exists
 * to prevent, produced by the mechanism meant to prevent it.
 *
 * Live for the caller's own registration only. Aborting a controller this library does not own is not
 * something this function can do, and a foreign entry is never ours to withdraw.
 */
export async function replaceRegistration(
  previousController: AbortController,
  declaration: ToolDeclaration,
  signal: AbortSignal,
  ownership: { holds(name: string): boolean },
): Promise<void> {
  // Resolved first, and awaited here, so that nothing below yields the turn.
  const { registry } = await ensureRegistry();

  if (signal.aborted) {
    // The replacement was withdrawn while the registry was being resolved. The previous registration is
    // left standing rather than withdrawn into nothing: aborting it here would take a working tool away
    // to install a registration nobody wants any more.
    throw new WebMcpBoundaryError(
      REGISTRATION_REFUSED.registrationWithdrawn,
      `the replacement registration of "${declaration.name}" was withdrawn before it reached the registry`,
      { subject: declaration.name },
    );
  }

  previousController.abort();
  try {
    // NO `await` between the abort above and this call. That is the whole mechanism.
    await registry.registerTool(toDescriptor(declaration), { signal });
  } catch (cause) {
    throw classifyRegistrationFailure(declaration.name, cause, signal, ownership);
  }
}

/**
 * Decides what a refused registration means from **this library's own state**.
 *
 * The exception's class, `name` and message are never read. The standard specifies an
 * `InvalidStateError` DOMException and the portability layer raises a plain `Error`, identically on
 * every engine tested — so a decision keyed off the error is correct under whichever implementation it
 * was written against and wrong under the other, silently. The signal and the ownership record give
 * the same answer under any implementation, because both are properties of this library rather than of
 * the platform.
 *
 * Invariant this function enforces: **the signal is consulted first.** An aborted signal is not a
 * contested name — nothing is contested, nothing was registered, and there is nothing for an
 * application to fix. Asking the ownership record first gets `false` for it and falls through to the
 * foreign branch, which reports a script on the page that does not exist. That was measured, not
 * imagined: it is what a strict-mode double-invoked effect produced on every mount.
 */
function classifyRegistrationFailure(
  name: string,
  cause: unknown,
  signal: AbortSignal,
  ownership: { holds(name: string): boolean },
): WebMcpBoundaryError {
  if (signal.aborted) {
    return fromPlatformFailure(
      REGISTRATION_REFUSED.registrationWithdrawn,
      `the registration of "${name}" was withdrawn before it reached the registry`,
      cause,
      name,
    );
  }
  if (ownership.holds(name)) {
    return fromPlatformFailure(
      REGISTRATION_REFUSED.nameHeldByThisApplication,
      `the tool name "${name}" is already registered by this application`,
      cause,
      name,
    );
  }
  return fromPlatformFailure(
    REGISTRATION_REFUSED.nameHeldByForeignOwner,
    `the tool name "${name}" is held by a script this library does not own — it is not ours to shadow, rename around or remove`,
    cause,
    name,
  );
}

/**
 * Reports what the registry currently holds, **including entries this library did not create**.
 *
 * Read on every call and never cached: a cached list is a second answer to a question the registry
 * already answers, and the two can disagree. Filtering foreign entries is the bridge's decision, made
 * against its ownership record — centralising it here would put it out of reach of the gate chain that
 * has to make it.
 */
export async function enumerate(): Promise<RegistryEntry[]> {
  const { registry } = await ensureRegistry();
  const entries = await registry.getTools();
  return entries.map(fromRegistryEntry);
}

/**
 * Subscribes to the registry's change event. Returns a disposer.
 *
 * The platform coalesces these onto a microtask, so several registrations in one turn produce one
 * event — which is the outcome a burst of registrations at mount wants. A caller asserting
 * synchronously after a registration sees nothing and will read it as a missing event.
 */
export async function onToolChange(listener: () => void): Promise<() => void> {
  const { registry } = await ensureRegistry();
  registry.addEventListener('toolchange', listener);
  return () => registry.removeEventListener('toolchange', listener);
}

/**
 * Discards the resolution memo. **Test support only** — there is no production reason to forget which
 * registry this document has, and calling it in a page would let a second registry be installed.
 */
export function resetResolutionForTests(): void {
  resolved = undefined;
}
