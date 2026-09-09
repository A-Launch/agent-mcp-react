// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toDescriptor } from '../../../src/webmcp/descriptor.ts';
import { REGISTRATION_REFUSED } from '../../../src/webmcp/errors.ts';
import {
  ensureRegistry,
  enumerate,
  onToolChange,
  register,
  resetResolutionForTests,
} from '../../../src/webmcp/registry.ts';
import {
  afterMicrotask,
  clearRegistryHosts,
  createStubRegistry,
  enterSecureContext,
  ownershipHolding,
  placeOnDocument,
} from './harness.ts';

// Registration, withdrawal, enumeration and change events against the real portability layer.
//
// These are conformance cases in the sense `docs/conformance.md` sets out: each one holds a behaviour
// of the platform that
// this library depends on. A version bump of the layer that changes any of them fails here rather than
// in a browser.

const declaration = (name: string) => ({
  name,
  description: `the ${name} tool`,
  handler: () => ({ ok: true }),
});

beforeEach(() => {
  resetResolutionForTests();
  clearRegistryHosts();
  enterSecureContext();
});

afterEach(() => {
  resetResolutionForTests();
  clearRegistryHosts();
});

describe('registering a tool', () => {
  it('registers it and makes it enumerable', async () => {
    const controller = new AbortController();

    await register(declaration('customers.set_filters'), controller.signal, ownershipHolding());

    const entries = await enumerate();
    expect(entries.map((entry) => entry.name)).toEqual(['customers.set_filters']);
  });

  it('withdraws it when the signal is aborted, and a second abort is harmless', async () => {
    const controller = new AbortController();
    await register(declaration('customers.set_filters'), controller.signal, ownershipHolding());

    controller.abort();
    await afterMicrotask();
    expect(await enumerate()).toEqual([]);

    // A double-invoked effect runs cleanup more than once. The second abort must remove nothing and
    // raise nothing; if it threw, StrictMode would surface it as an error in every development run.
    expect(() => controller.abort()).not.toThrow();
    expect(await enumerate()).toEqual([]);
  });

  it('registers nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      register(declaration('customers.set_filters'), controller.signal, ownershipHolding()),
    ).rejects.toBeDefined();

    // A tool that exists but has no owner is worse than no tool: nothing would ever withdraw it.
    expect(await enumerate()).toEqual([]);
  });

  it('reports entries this library did not create', async () => {
    const { registry } = await ensureRegistry();
    // Registered straight into the registry, standing in for another script on the page.
    await registry.registerTool(toDescriptor(declaration('someone.elses_tool')));
    await register(declaration('ours.tool'), new AbortController().signal, ownershipHolding());

    const entries = await enumerate();

    // Enumeration reports everything. Deciding what to do about a foreign entry is the bridge's
    // decision, made against its ownership record — filtering here would put that decision out of
    // reach of the gate chain that has to make it.
    expect(entries.map((entry) => entry.name).sort()).toEqual(['ours.tool', 'someone.elses_tool']);
  });
});

describe('a refused registration', () => {
  it('is classified as a duplicate when this application already holds the name', async () => {
    const controller = new AbortController();
    await register(declaration('customers.set_filters'), controller.signal, ownershipHolding());

    // The ownership record says the name is ours, so this is this application colliding with itself.
    await expect(
      register(
        declaration('customers.set_filters'),
        new AbortController().signal,
        ownershipHolding('customers.set_filters'),
      ),
    ).rejects.toMatchObject({
      code: REGISTRATION_REFUSED.nameHeldByThisApplication,
      subject: 'customers.set_filters',
    });
  });

  it('is classified as a foreign conflict when the ownership record does not hold the name', async () => {
    const { registry } = await ensureRegistry();
    await registry.registerTool(toDescriptor(declaration('someone.elses_tool')));

    await expect(
      register(declaration('someone.elses_tool'), new AbortController().signal, ownershipHolding()),
    ).rejects.toMatchObject({
      code: REGISTRATION_REFUSED.nameHeldByForeignOwner,
      subject: 'someone.elses_tool',
    });
  });

  it('is caught even though the platform throws it synchronously', async () => {
    // The platform uses two failure channels: an already-aborted signal returns a rejected promise,
    // while a duplicate name throws before any promise exists. `registerTool(...).catch(fn)` sees the
    // first and lets the second escape as an uncaught exception.
    //
    // This case is what holds `try { await ... }` in place. Refactor `register` to a trailing
    // `.catch()` and this turns red while everything else stays green.
    const thrower = createStubRegistry({ failRegistration: new Error('thrown, not rejected') });
    placeOnDocument(thrower);

    await expect(
      register(declaration('any.tool'), new AbortController().signal, ownershipHolding()),
    ).rejects.toMatchObject({ code: REGISTRATION_REFUSED.nameHeldByForeignOwner });
  });

  it('classifies the same way when the platform raises a different kind of error', async () => {
    // The standard specifies an InvalidStateError DOMException; the portability layer raises a plain
    // Error. Anything keyed off the class, the name or the message is correct under one implementation
    // and wrong under the other — so the verdict must not move when the error does.
    const domException = new DOMException('Tool already registered', 'InvalidStateError');
    placeOnDocument(createStubRegistry({ failRegistration: domException }));

    await expect(
      register(declaration('a.tool'), new AbortController().signal, ownershipHolding('a.tool')),
    ).rejects.toMatchObject({ code: REGISTRATION_REFUSED.nameHeldByThisApplication });

    resetResolutionForTests();
    clearRegistryHosts();
    placeOnDocument(
      createStubRegistry({ failRegistration: new TypeError('something else entirely') }),
    );

    await expect(
      register(declaration('a.tool'), new AbortController().signal, ownershipHolding('a.tool')),
    ).rejects.toMatchObject({ code: REGISTRATION_REFUSED.nameHeldByThisApplication });
  });

  it('never lets a platform value reach the caller', async () => {
    const platform = new TypeError('an implementation-specific message');
    placeOnDocument(createStubRegistry({ failRegistration: platform }));

    const failure = await register(
      declaration('a.tool'),
      new AbortController().signal,
      ownershipHolding(),
    ).catch((error: unknown) => error);

    // The platform value is reachable as a cause, for a human reading a console. What crosses the
    // boundary is this project's own named failure.
    expect(failure).toMatchObject({ code: REGISTRATION_REFUSED.nameHeldByForeignOwner });
    expect((failure as { cause?: unknown }).cause).toBe(platform);
    expect(failure).not.toBe(platform);
  });
});

describe('change events', () => {
  it('fire on registration and stop when the subscription is disposed', async () => {
    let fired = 0;
    const dispose = await onToolChange(() => {
      fired += 1;
    });

    await register(declaration('a.tool'), new AbortController().signal, ownershipHolding());
    await afterMicrotask();
    expect(fired).toBe(1);

    dispose();
    await register(declaration('b.tool'), new AbortController().signal, ownershipHolding());
    await afterMicrotask();
    expect(fired).toBe(1);
  });

  it('are coalesced, so several registrations in one turn cost one event', async () => {
    let fired = 0;
    await onToolChange(() => {
      fired += 1;
    });

    await Promise.all([
      register(declaration('a.tool'), new AbortController().signal, ownershipHolding()),
      register(declaration('b.tool'), new AbortController().signal, ownershipHolding()),
      register(declaration('c.tool'), new AbortController().signal, ownershipHolding()),
    ]);
    await afterMicrotask();

    // A burst of registrations at mount costing one notification is the outcome the change-notification
    // path wants. It is also why a case that asserts synchronously after a registration sees nothing
    // and reads it as a missing event.
    expect(fired).toBe(1);
    expect((await enumerate()).length).toBe(3);
  });
});

describe('a registration whose signal aborted first', () => {
  // Registration is asynchronous and React's effects are not, so a component that unmounts while its
  // registration is in flight arrives here. It is the normal condition of a strict-mode double-invoked
  // effect, not a fault — and what this library reports about it is the whole point of these cases.

  it('is refused as withdrawn, and registers nothing', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      register(declaration('a.tool'), controller.signal, ownershipHolding()),
    ).rejects.toMatchObject({ code: REGISTRATION_REFUSED.registrationWithdrawn });

    expect(await enumerate()).toEqual([]);
  });

  it('is NEVER reported as a name held by a foreign owner', async () => {
    // The negative half, and the reason this pair exists. Classifying from the ownership record alone
    // answers "not ours" for a withdrawn registration and falls through to the foreign branch — which
    // sends an author looking for a script on the page that is not there, on every mount in
    // development. Asserting only the positive above would keep passing if the order were restored.
    const controller = new AbortController();
    controller.abort();

    const refusal = await register(
      declaration('a.tool'),
      controller.signal,
      ownershipHolding(),
    ).then(
      () => undefined,
      (error: unknown) => error as { code: string },
    );

    expect(refusal?.code).not.toBe(REGISTRATION_REFUSED.nameHeldByForeignOwner);
    expect(refusal?.code).not.toBe(REGISTRATION_REFUSED.nameHeldByThisApplication);
  });

  it('still reports a genuinely foreign name as foreign when the signal is live', async () => {
    // The check added for the case above must not swallow the one it sits in front of. A live signal
    // and a name the ownership record does not hold is still a foreign owner.
    await register(declaration('a.tool'), new AbortController().signal, ownershipHolding());

    await expect(
      register(declaration('a.tool'), new AbortController().signal, ownershipHolding('b.tool')),
    ).rejects.toMatchObject({ code: REGISTRATION_REFUSED.nameHeldByForeignOwner });
  });
});
