// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRegistrationGateway } from '../../../src/react/registration.ts';
import {
  createOwnershipRecord,
  type OwnershipRecord,
  type ToolHandler,
} from '../../../src/runtime/index.ts';
import { REGISTRATION_REFUSED } from '../../../src/webmcp/index.ts';
import {
  ensureRegistry,
  register,
  replaceRegistration,
  resetResolutionForTests,
} from '../../../src/webmcp/registry.ts';

// The registration gateway on its own, driven at the timings React produces but without a renderer.
//
// It exists here rather than only in `tests/react/` because the guarantee is about ORDER, and a
// renderer decides the order for you. Driving `enqueue`, `open` and `abort` directly is what lets a
// case put two registrations of one name into the exact interleaving that a route change back and
// forth produces and strict mode does not.

beforeEach(() => {
  resetResolutionForTests();
  Reflect.deleteProperty(document as object, 'modelContext');
  Reflect.deleteProperty(navigator as object, 'modelContext');
  Reflect.deleteProperty(globalThis as object, '__webMCPPolyfillOptions');
  Object.defineProperty(globalThis, 'isSecureContext', {
    value: true,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  resetResolutionForTests();
  Reflect.deleteProperty(document as object, 'modelContext');
  Reflect.deleteProperty(navigator as object, 'modelContext');
  Reflect.deleteProperty(globalThis as object, '__webMCPPolyfillOptions');
});

const handler: ToolHandler = () => ({ ok: true });

function request(name: string, controller: AbortController) {
  return {
    declaration: { name, description: `the ${name} tool`, handler: () => ({ ok: true }) },
    handler,
    controller,
  };
}

async function registeredNames(): Promise<string[]> {
  const { registry } = await ensureRegistry();
  return (await registry.getTools()).map((tool) => tool.name);
}

/** A record that reports what the gateway did to it, in order. */
function recordingOwnership(log: string[]): OwnershipRecord {
  const inner = createOwnershipRecord();
  return {
    holds: (name) => inner.holds(name),
    entryFor: (name) => inner.entryFor(name),
    divergedFrom: (names) => inner.divergedFrom(names),
    onChange: (listener) => inner.onChange(listener),
    add(name, entry) {
      log.push(`add:${name}`);
      inner.add(name, entry);
    },
    remove(name) {
      log.push(`remove:${name}`);
      inner.remove(name);
    },
  };
}

describe('the gateway waits for the provider before touching the registry', () => {
  it('registers nothing until the provider opens it', async () => {
    const gateway = createRegistrationGateway();
    const log: string[] = [];
    const ownership = recordingOwnership(log);

    void gateway.enqueue(request('a.tool', new AbortController()));
    await Promise.resolve();
    await Promise.resolve();

    // The whole reason the gateway exists: a child's effect runs BEFORE its parent's, so this is the
    // state a `useMcpTool` is in while the provider has not resolved a registry yet.
    expect(log).toEqual([]);

    gateway.open(ownership);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await registeredNames()).toEqual(['a.tool']);
  });

  it('drops queued work when the provider tore down instead of opening', async () => {
    const gateway = createRegistrationGateway();
    const log: string[] = [];

    const enqueued = gateway.enqueue(request('a.tool', new AbortController()));
    gateway.close();

    // Resolves rather than hanging. A queued task waiting on a provider that never arrived would be a
    // promise nobody settles, which is the leak that turns an unmounted route into a slow drip.
    await expect(enqueued).resolves.toBeUndefined();
    expect(log).toEqual([]);
  });
});

describe('a registration whose controller aborts', () => {
  it('is skipped before the provider opens, and registers nothing', async () => {
    const gateway = createRegistrationGateway();
    const log: string[] = [];
    const controller = new AbortController();

    const enqueued = gateway.enqueue(request('a.tool', controller));
    controller.abort();
    gateway.open(recordingOwnership(log));

    await expect(enqueued).resolves.toBeUndefined();
    expect(await registeredNames()).toEqual([]);
    expect(log).toEqual([]);
  });

  it('is skipped after the provider opens, while the task waits its turn', async () => {
    const gateway = createRegistrationGateway();
    const log: string[] = [];
    const ownership = recordingOwnership(log);
    gateway.open(ownership);

    const controller = new AbortController();
    const enqueued = gateway.enqueue(request('a.tool', controller));
    controller.abort();

    await expect(enqueued).resolves.toBeUndefined();
    expect(await registeredNames()).toEqual([]);
    expect(log).toEqual([]);
  });

  it('withdraws the registration and clears the entry when it aborts afterwards', async () => {
    const gateway = createRegistrationGateway();
    const log: string[] = [];
    gateway.open(recordingOwnership(log));

    const controller = new AbortController();
    await gateway.enqueue(request('a.tool', controller));
    expect(await registeredNames()).toEqual(['a.tool']);
    expect(log).toEqual(['add:a.tool']);

    controller.abort();

    // One abort, both effects. The registry has no unregister operation, so aborting is the whole
    // withdrawal — and hanging the record removal off that same event is what makes the two
    // structurally unable to drift.
    expect(await registeredNames()).toEqual([]);
    expect(log).toEqual(['add:a.tool', 'remove:a.tool']);
  });
});

describe('two registrations of ONE name', () => {
  it('do not overlap: the second starts only after the first has finished', async () => {
    const gateway = createRegistrationGateway();
    const log: string[] = [];
    const ownership = recordingOwnership(log);
    gateway.open(ownership);

    // The interleaving a route change back and forth produces, and strict mode does not: the first
    // registration is genuinely in flight — past both abort checks, inside the platform call — when
    // the component unmounts and mounts again.
    const first = new AbortController();
    const firstAttempt = gateway.enqueue(request('a.tool', first));
    await Promise.resolve();

    first.abort();
    const second = new AbortController();
    const secondAttempt = gateway.enqueue(request('a.tool', second));

    await expect(firstAttempt).resolves.toBeUndefined();
    await expect(secondAttempt).resolves.toBeUndefined();

    // Exactly one live registration, and it is the second one. Without ordering, the second reaches
    // the registry while the first is still inside it and is refused for a name that is about to be
    // free.
    expect(await registeredNames()).toEqual(['a.tool']);
    expect(ownership.holds('a.tool')).toBe(true);
  });

  it('reports a CONCURRENT duplicate as this application colliding with itself', async () => {
    const gateway = createRegistrationGateway();
    gateway.open(recordingOwnership([]));

    // Two live components claiming one name in the same turn — a screen that renders the same widget
    // twice. Both registrations are in flight at once, so whether the ownership record has been
    // written yet decides what the refusal SAYS. Unordered, the loser asks a record the winner has not
    // updated, gets "not ours", and reports a script on the page that does not exist — sending an
    // author to look for a conflict outside their own code.
    const outcomes = await Promise.allSettled([
      gateway.enqueue(request('a.tool', new AbortController())),
      gateway.enqueue(request('a.tool', new AbortController())),
    ]);

    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(refused?.status).toBe('rejected');
    expect((refused as PromiseRejectedResult | undefined)?.reason).toMatchObject({
      code: REGISTRATION_REFUSED.nameHeldByThisApplication,
    });
    expect(await registeredNames()).toEqual(['a.tool']);
  });

  it('reports a genuine duplicate — two live components claiming one name', async () => {
    const gateway = createRegistrationGateway();
    gateway.open(recordingOwnership([]));

    await gateway.enqueue(request('a.tool', new AbortController()));

    // Both live. This is the application colliding with itself, and it is the author's to fix — so it
    // is NOT swallowed the way a withdrawn registration is.
    await expect(gateway.enqueue(request('a.tool', new AbortController()))).rejects.toMatchObject({
      code: expect.stringContaining('MCP_TOOL_NAME'),
    });
  });
});

describe('two registrations of DIFFERENT names', () => {
  it('do not serialize behind each other', async () => {
    const gateway = createRegistrationGateway();
    gateway.open(recordingOwnership([]));

    // A screen registering its whole tool set at mount must not pay for one queue. The race being
    // fixed is a race over a name, so the ordering is per name.
    await Promise.all([
      gateway.enqueue(request('a.tool', new AbortController())),
      gateway.enqueue(request('b.tool', new AbortController())),
      gateway.enqueue(request('c.tool', new AbortController())),
    ]);

    expect((await registeredNames()).sort()).toEqual(['a.tool', 'b.tool', 'c.tool']);
  });
});

describe('the gateway is not a second registry', () => {
  it('offers no way to ask what exists', () => {
    const gateway = createRegistrationGateway();

    // The surface IS the guarantee, asserted against the surface itself so it holds for call sites
    // that do not exist yet. What makes this an ordering structure rather than a registry is not how
    // little it holds — it is what it is never asked.
    //
    // `refresh` joined the list and is not the operation this case forbids. It WRITES fields the
    // registry cannot carry, onto a name the registry already holds, and it answers nothing: there is
    // still no way to ask this gateway what exists, what a tool's schema is, or whether a name is
    // taken. Those have one answer and it lives in the document's registry, which is the sole
    // authority on what is registered (`docs/design.md#registration-follows-the-commit`).
    expect(Object.keys(gateway).sort()).toEqual(['close', 'enqueue', 'open', 'refresh', 'replace']);
  });
});

describe('a refresh that lost its race', () => {
  // **The guards on `refresh`, put into the interleavings a renderer will not produce on demand.**
  //
  // A refresh is queued in one turn and runs in a later one. In between, the component can unmount,
  // rename, or the provider can tear down — and in every one of those the entry it was going to write
  // belongs to a registration that is over. Writing anyway puts an ownership entry under a name the
  // registry does not hold, which the runtime correctly reports as a broken invariant: an operator
  // chasing an alarm about a tool nobody touched.
  //
  // These are here rather than in a React suite because a renderer decides the order for you. The
  // React cases drive the same code and cannot create the window: the gateway is already open, so the
  // refresh runs to completion before the unmount is even scheduled. Measured — deleting all three
  // guards leaves every React case green.
  //
  // **A first break-it run suggested the three guards were mutually redundant, and an adversarial
  // review showed that reading was wrong — because the cases were too weak, not because the guards
  // were.** Two of them are independently load-bearing once the right interleaving exists:
  //
  //   - **identity** — a registration that FAILED still has a live controller. Its component can
  //     rerender with a new permission, and without this check that permission is written onto the
  //     entry belonging to whoever actually holds the name. A cross-tool write, from a tool that was
  //     never registered.
  //   - **epoch** — a refresh queued for a provider that closes and never reopens would otherwise wait
  //     forever on `availability()`, holding the name's promise chain and its own promise with it. The
  //     first version of that case reopened a gateway immediately, which released the wait and hid it.
  //
  // The withdrawal check remains an early return rather than a mechanism: an abort removes the entry
  // synchronously, so the identity check answers those cases too. It is kept for the same reason
  // `perform` keeps its own — it avoids pointless work on the common path — and is labelled as such.

  it('does nothing when its registration was withdrawn first', async () => {
    // Asserts the outcome. The withdrawal check is an early return here rather than the mechanism: the
    // abort removes the entry synchronously, so the identity check would answer this too.
    const gateway = createRegistrationGateway();
    const ownership = createOwnershipRecord();
    const controller = new AbortController();

    gateway.open(ownership);
    await gateway.enqueue(request('panel.set', controller));

    // Queued while the registration is live, then withdrawn before it is allowed to run.
    const refreshing = gateway.refresh({
      name: 'panel.set',
      controller,
      permissions: { available: false },
    });
    controller.abort();
    await refreshing;

    // The abort removed the entry. A refresh that wrote anyway would put it back — with no registry
    // entry behind it.
    expect(ownership.holds('panel.set')).toBe(false);
  });

  it('does nothing when the provider it was queued for has torn down', async () => {
    // The outcome. The liveness half — which is what makes the epoch check load-bearing — is the case
    // below, where no second provider ever arrives.
    const gateway = createRegistrationGateway();
    const first = createOwnershipRecord();
    const controller = new AbortController();

    gateway.open(first);
    await gateway.enqueue(request('panel.set', controller));

    // Queued against the gateway, then the provider goes away before it can run. Without the epoch
    // check the task waits for the NEXT provider's `open` and writes into ITS record — a record that
    // never registered this tool.
    const refreshing = gateway.refresh({
      name: 'panel.set',
      controller,
      permissions: { available: false },
    });
    gateway.close();
    const second = createOwnershipRecord();
    gateway.open(second);
    await refreshing;

    expect(second.holds('panel.set')).toBe(false);
  });

  it('settles when the provider closes and never comes back', async () => {
    // **The epoch guard's own case**, and the one the version above cannot make: it opened a second
    // gateway immediately, which released the wait and would have passed without the check.
    //
    // A page that navigates away closes the gateway and opens nothing. Without the epoch check the
    // refresh reaches `availability()` AFTER `close()` released its waiters, so it joins a queue
    // nobody will ever drain — and it takes that name's promise chain with it, so every later task for
    // the name hangs behind it. A promise nobody settles, retained for the life of the page, for every
    // route that mounted and left.
    const gateway = createRegistrationGateway();
    const ownership = createOwnershipRecord();
    const controller = new AbortController();

    gateway.open(ownership);
    await gateway.enqueue(request('panel.set', controller));

    const refreshing = gateway.refresh({
      name: 'panel.set',
      controller,
      permissions: { available: false },
    });
    gateway.close();

    const settled = await Promise.race([
      refreshing.then(() => 'settled'),
      new Promise<'still waiting'>((resolve) => {
        setTimeout(() => resolve('still waiting'), 250);
      }),
    ]);

    expect(settled).toBe('settled');
  });

  it("does not write a failed registration's permission onto the tool that holds the name", async () => {
    // **The identity guard's own case**, found by an adversarial review. The interleaving the earlier
    // cases could not reach: a registration that FAILED — a contested name — leaves its controller
    // live, because nothing aborted it. Its component then rerenders with a permission, and the
    // refresh names a tool that belongs to somebody else.
    //
    // Without the identity comparison, the withdrawn and epoch guards both pass: the controller is not
    // aborted and the epoch has not moved. A tool that was never registered would close a tool that
    // was.
    const gateway = createRegistrationGateway();
    const ownership = createOwnershipRecord();
    const holder = new AbortController();
    const contender = new AbortController();

    gateway.open(ownership);
    await gateway.enqueue(request('panel.set', holder));
    // The second claim on the name is refused by the registry, and its controller stays live.
    await gateway.enqueue(request('panel.set', contender)).catch(() => undefined);
    expect(contender.signal.aborted).toBe(false);

    await gateway.refresh({
      name: 'panel.set',
      controller: contender,
      permissions: { available: false },
    });

    expect(ownership.entryFor('panel.set')?.controller).toBe(holder);
    expect(ownership.entryFor('panel.set')?.permissions).toBeUndefined();
  });

  it('does nothing when the name is held by a different registration now', async () => {
    // The rename case: after a remount the
    // name is held again, by a controller that is not ours, and a stale permission written over the
    // top of it would close a tool the application is currently offering.
    const gateway = createRegistrationGateway();
    const ownership = createOwnershipRecord();
    const gone = new AbortController();
    const live = new AbortController();

    gateway.open(ownership);
    await gateway.enqueue(request('panel.set', gone));
    gone.abort();
    await gateway.enqueue(request('panel.set', live));

    await gateway.refresh({
      name: 'panel.set',
      controller: gone,
      permissions: { available: false },
    });

    // The live registration's entry is untouched — no permissions were written onto it.
    expect(ownership.entryFor('panel.set')?.controller).toBe(live);
    expect(ownership.entryFor('panel.set')?.permissions).toBeUndefined();
  });

  it('writes when nothing raced it, which is what makes the three above mean anything', async () => {
    // The pairing. A `refresh` that never wrote would satisfy every case above and would make
    // `permissions.available` a field nothing reads.
    const gateway = createRegistrationGateway();
    const ownership = createOwnershipRecord();
    const controller = new AbortController();

    gateway.open(ownership);
    await gateway.enqueue(request('panel.set', controller));
    await gateway.refresh({
      name: 'panel.set',
      controller,
      permissions: { available: false },
    });

    expect(ownership.entryFor('panel.set')?.permissions).toEqual({ available: false });
  });

  it('clears a permission the application has stopped declaring', async () => {
    // Spreading the new value over the old would leave a tool closed under a value nobody is declaring
    // any more — and an author who deleted the `permissions` line would find the tool still refused.
    const gateway = createRegistrationGateway();
    const ownership = createOwnershipRecord();
    const controller = new AbortController();

    gateway.open(ownership);
    await gateway.enqueue(request('panel.set', controller));
    await gateway.refresh({ name: 'panel.set', controller, permissions: { available: false } });
    await gateway.refresh({ name: 'panel.set', controller, permissions: undefined });

    expect(ownership.entryFor('panel.set')?.permissions).toBeUndefined();
  });

  it('never touches the registry', async () => {
    // The whole reason this path exists rather than routing through `replace`.
    const gateway = createRegistrationGateway();
    const ownership = createOwnershipRecord();
    const controller = new AbortController();
    const { registry } = await ensureRegistry();

    gateway.open(ownership);
    await gateway.enqueue(request('panel.set', controller));
    await new Promise((resolve) => setTimeout(resolve, 5));

    let changes = 0;
    registry.addEventListener('toolchange', () => {
      changes += 1;
    });

    await gateway.refresh({ name: 'panel.set', controller, permissions: { available: false } });
    await gateway.refresh({ name: 'panel.set', controller, permissions: { available: true } });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(changes).toBe(0);
    expect(await registeredNames()).toContain('panel.set');
  });
});

describe('why the replacement path sequences the way it does', () => {
  // This case asserts a LIMITATION on purpose, and it is the reason `replaceRegistration` resolves the
  // registry before aborting. Without it, the sequencing in that function reads as a stylistic oddity
  // and the next reader tidies it into the obvious spelling — at which point every descriptor change
  // silently costs two change events again, and nothing goes red.

  it('an abort followed by an AWAITED registration produces two change events', async () => {
    const { registry } = await ensureRegistry();
    const first = new AbortController();
    await register(request('seq.tool', first).declaration, first.signal, createOwnershipRecord());
    await new Promise((resolve) => setTimeout(resolve, 5));

    let events = 0;
    registry.addEventListener('toolchange', () => {
      events += 1;
    });

    // The obvious spelling: abort, then await a registration that resolves the registry first. The
    // withdrawal's event is delivered while that resolution is still pending.
    first.abort();
    await register(
      { name: 'seq.tool', description: 'changed', handler: () => ({}) },
      new AbortController().signal,
      createOwnershipRecord(),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(events).toBe(2);
  });

  it('the same pair with nothing awaited between them produces one', async () => {
    const { registry } = await ensureRegistry();
    const first = new AbortController();
    const second = new AbortController();
    await replaceRegistration(
      new AbortController(),
      { name: 'seq.two', description: 'first', handler: () => ({}) },
      first.signal,
      createOwnershipRecord(),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    let events = 0;
    registry.addEventListener('toolchange', () => {
      events += 1;
    });

    await replaceRegistration(
      first,
      { name: 'seq.two', description: 'second', handler: () => ({}) },
      second.signal,
      createOwnershipRecord(),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(events).toBe(1);
    expect((await registry.getTools()).find((tool) => tool.name === 'seq.two')?.description).toBe(
      'second',
    );
  });
});
