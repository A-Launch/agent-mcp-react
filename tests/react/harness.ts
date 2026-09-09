import { act } from '@testing-library/react';
import { Component, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { UnexpectedStateReport } from '../../src/react/index.ts';
import { createAjvValidator } from '../../src/validation/ajv.ts';
import { resetResolutionForTests } from '../../src/webmcp/registry.ts';

// Shared setup for the React layer's lifecycle cases: everything that must be done exactly right for
// a case here to pass for the reason it claims.
//
// Three things, each of which makes a case wrong when it is missed:
//
//   1. **A secure context must be declared, not inherited.** jsdom does not implement
//      `isSecureContext`, and the boundary treats an environment that cannot say whether it is secure
//      as not being one. A case that simply ran would be testing the insecure-origin path.
//   2. **The document must be returned to having no registry between cases.** The portability layer
//      defines its host properties as configurable, so they can be deleted. A case inheriting a
//      registry silently exercises the already-present path.
//   3. **Trees must be unmounted between cases.** This library's central claim is that unmount
//      withdraws a tool, so a tree left mounted leaves registrations behind and the next case asserts
//      against a polluted registry — passing or failing for a reason unrelated to it.
//
// The portability layer is never imported here. Importing it initializes it, which would install a
// registry into every case before its first line ran.

/**
 * The validator these cases install, because they are applications and their tools declare schemas.
 *
 * A tool that declares an `inputSchema` with no validator present is not registered at all — a tool
 * may never promise a contract nothing enforces, and that applies to a test exactly as it applies to
 * a page. Sharing one
 * instance is safe: compiled schemas are keyed by the schema, and nothing here is per-case state.
 */
export const testValidator = createAjvValidator();

/** Declares the environment a real page is in: a secure context. */
export function enterSecureContext(): void {
  Object.defineProperty(globalThis, 'isSecureContext', {
    value: true,
    configurable: true,
    writable: true,
  });
}

/** Returns the document to having no registry, and forgets which one was resolved. */
export function clearRegistry(): void {
  resetResolutionForTests();
  Reflect.deleteProperty(document as object, 'modelContext');
  if (typeof navigator !== 'undefined') Reflect.deleteProperty(navigator as object, 'modelContext');
  Reflect.deleteProperty(globalThis as object, '__webMCPPolyfillOptions');
}

/**
 * Counts what the registry itself reports, which is the only number that can see this feature's defect.
 *
 * **Never count registrations.** A rerender that withdraws a tool and registers it again leaves the
 * registration count at exactly one — correct at rest, and correct after every cycle. That is precisely
 * how a withdraw-and-register cycle per rerender once shipped past a green suite. The change event is
 * what an agent would observe as a `tools/list_changed` storm, and it is what these cases assert on.
 *
 * The listener attaches to whatever registry the document currently has, so call this AFTER a provider
 * has resolved one.
 */
export function recordChanges(): { count(): number; reset(): void; stop(): void } {
  const host = (document as unknown as { modelContext?: EventTarget }).modelContext;
  if (host === undefined) {
    throw new Error('no registry on the document yet — resolve one before recording its changes');
  }
  let seen = 0;
  const listener = (): void => {
    seen += 1;
  };
  host.addEventListener('toolchange', listener);
  return {
    count: () => seen,
    reset: () => {
      seen = 0;
    },
    stop: () => host.removeEventListener('toolchange', listener),
  };
}

/**
 * Mounts a tree through the renderer directly, **outside `act()`**.
 *
 * This exists for one case and the reason is worth the whole helper: `act()` flushes passive effects
 * synchronously, so under it a handler updated in a passive effect and one updated in a layout effect
 * read identically. The window this library has to close — a call arriving in the task after a commit,
 * which is how every agent call arrives — does not exist inside `act()`. A case for it written with
 * React Testing Library cannot fail.
 *
 * The cost is that updates here are not batched by the test harness, which is why nothing else uses it.
 */
export function renderOutsideAct(element: ReactNode): {
  rerender(next: ReactNode): void;
  unmount(): void;
} {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(element);
  return {
    rerender: (next) => root.render(next),
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}

/** Yields the turn, for assertions about what a caller in a LATER task observes. */
export function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Reads the registry directly, so a case can assert what an in-page caller would find. */
export async function registeredNames(): Promise<string[]> {
  const host = (
    document as unknown as { modelContext?: { getTools(): Promise<{ name: string }[]> } }
  ).modelContext;
  if (host === undefined) return [];
  return (await host.getTools()).map((tool) => tool.name);
}

/** What a case collects from a provider: the alarms it raised and the failures it threw. */
export interface Recorder {
  /** Both kinds the destination now carries: a registry-integrity alarm, and a contested name. */
  readonly unexpected: UnexpectedStateReport[];
  readonly caught: unknown[];
}

export function recorder(): Recorder {
  return { unexpected: [], caught: [] };
}

/**
 * An error boundary that records what it caught and renders nothing afterwards.
 *
 * Cases assert through this rather than through an expected throw, because the failure being tested
 * arrives from an effect and from asynchronous work — the renderer routes those here, and a case
 * wrapped in `expect(...).toThrow()` would see nothing and pass.
 */
export function boundary(into: Recorder, children: ReactNode): ReactNode {
  return createElement(RecordingBoundary, { into, children });
}

class RecordingBoundary extends Component<
  { into: Recorder; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.into.caught.push(error);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Waits until an observable condition holds, and says what it was waiting for when it never does.
 *
 * The provider's mount is genuinely asynchronous — resolving a registry, registering, dialing — so a
 * case has to wait for something. What it must never do is wait for a *duration*: a `setTimeout` long
 * enough to pass today is a synchronization mechanism that fails on a slower machine and gets widened
 * instead of the cause being fixed. This waits for the condition itself and fails loudly, naming
 * it, rather than continuing on an assumption.
 */
export async function until(
  holds: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    if (await holds()) return;
    // Inside `act`, because the provider's mount reports connection states asynchronously and those
    // are real state updates. Waiting outside it would leave the renderer complaining on every case
    // about updates it did not see — noise that trains a reader to ignore the channel that would
    // report a genuine one.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  }
  throw new Error(`waited for ${description} and it never became true`);
}

/**
 * Lets the mount's already-started asynchronous work run to completion.
 *
 * For assertions about an ABSENCE, where there is no condition to wait for — nothing registered,
 * nothing connected, nothing thrown. It yields the turn rather than timing anything.
 */
export async function afterMount(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** A `getUrl` that never returns, for cases about everything except the connection. */
export function neverConnects(): Promise<string> {
  return new Promise<string>(() => undefined);
}

/** The code carried by a failure, without asserting anything about its class. */
export function codeOf(failure: unknown): string | undefined {
  const code = (failure as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}
