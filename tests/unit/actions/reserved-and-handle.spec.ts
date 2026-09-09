import { afterEach, describe, expect, it } from 'vitest';
import { registerMcpTool } from '../../../src/actions/index.ts';
import { declared, resetDeclarationsForTests } from '../../../src/actions/queue.ts';
import { REGISTRATION_REFUSED, WebMcpBoundaryError } from '../../../src/webmcp/index.ts';

// The imperative path's own refusals and its handle, with no provider and no registry in sight.
//
// These are the checks that must happen at DECLARATION, and testing them here rather than through a
// mounted provider is the point: a reserved name is refused whether or not anything is listening, and
// a check that needed a provider would be one an application could get past by declaring early.

afterEach(resetDeclarationsForTests);

const DEFINITION = {
  name: 'session.logout',
  description: 'Logs out the current user.',
  handler: () => ({ ok: true }),
};

describe('a reserved name', () => {
  it('is refused synchronously, in the EXISTING vocabulary', () => {
    // Not a new code. The question "why was this name not registered" has one dictionary, and a caller
    // already catching this from a hook needs no new branch for the imperative path — one owner per
    // truth, and the vocabulary is the owner.
    let caught: unknown;
    try {
      registerMcpTool({ ...DEFINITION, name: 'dom.click' });
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(WebMcpBoundaryError);
    expect((caught as WebMcpBoundaryError).code).toBe(REGISTRATION_REFUSED.nameReserved);
    // Nothing was queued. A refusal that still declared would leave a tool waiting to be registered
    // under a name this library reserves for its own built-ins.
    expect(declared()).toEqual([]);
  });

  it('is refused on a RENAME too, so update() is not the way past the check', () => {
    const handle = registerMcpTool(DEFINITION);
    expect(() => handle.update({ name: 'runtime.evaluate' })).toThrow(WebMcpBoundaryError);
    // The original declaration is untouched: a refused rename must not damage what was already valid.
    expect(declared().map((entry) => entry.definition.name)).toEqual(['session.logout']);
  });

  it('permits a name that merely starts with the same letters — a PREFIX, never a substring', () => {
    // `domain.` is not `dom.`. This guarantee belongs to `reservedPrefixOf` and the imperative path
    // adds nothing to it, which is exactly why it reuses it rather than testing the prefixes itself.
    expect(() => registerMcpTool({ ...DEFINITION, name: 'domain.set_filters' })).not.toThrow();
  });
});

describe('the handle', () => {
  it('reports that nothing is registered when no provider ever mounts', () => {
    // Reported, never thrown about. A module-scope declaration normally has no provider yet — that is
    // the case declaring a tool outside React exists for rather than a fault
    // (`docs/tools-outside-react.md`) — but a tool that NEVER registers must be visible rather than a
    // mystery. An unexpected state fails loud; it is not quietly defaulted away.
    const handle = registerMcpTool(DEFINITION);
    expect(handle.registered).toBe(false);
  });

  it('is idempotent on remove()', () => {
    const handle = registerMcpTool(DEFINITION);
    handle.remove();
    expect(declared()).toEqual([]);
    expect(() => handle.remove()).not.toThrow();
    expect(declared()).toEqual([]);
  });

  it('ignores update() after remove(), rather than resurrecting the declaration', () => {
    // `remove()` is permanent. An update that re-added the declaration would make it conditional on
    // nobody calling anything afterwards.
    const handle = registerMcpTool(DEFINITION);
    handle.remove();
    handle.update({ description: 'changed' });
    expect(declared()).toEqual([]);
  });

  it('ignores update() after remove() even when the update would otherwise be REFUSED', () => {
    // **A review found this ordering, and it is the sharper half of "update after remove is a
    // no-op".** With the reserved-name check running before the liveness check, a removed handle
    // asked to rename into `dom.` threw — a refusal for a registration that no longer exists, which
    // an application cannot act on and did not earn. "No-op" has to mean no-op, including no throw.
    const handle = registerMcpTool(DEFINITION);
    handle.remove();
    expect(() => handle.update({ name: 'dom.click' })).not.toThrow();
    expect(declared()).toEqual([]);
  });

  it('merges a partial update rather than replacing the definition', () => {
    // The update is typed `Partial` (`docs/tools-outside-react.md`), so an application updating a
    // description must not have to restate its handler and schema.
    const handle = registerMcpTool(DEFINITION);
    handle.update({ description: 'Ends the current session.' });
    const entry = declared()[0];
    expect(entry?.definition.description).toBe('Ends the current session.');
    expect(entry?.definition.handler).toBe(DEFINITION.handler);
    expect(entry?.definition.name).toBe('session.logout');
  });

  it('offers no enable() or disable()', () => {
    // The handle deliberately offers neither. Availability is per-tool policy declared as a value and
    // refused at invocation (`docs/reference-capabilities.md#per-tool-permissions`);
    // a second switch here could disagree with it, and the disagreement would be invisible.
    const handle = registerMcpTool(DEFINITION) as unknown as Record<string, unknown>;
    expect(handle.enable).toBeUndefined();
    expect(handle.disable).toBeUndefined();
  });
});

describe('a teardown speaks only for itself', () => {
  it('ignores a release from an adopter that has already been replaced', async () => {
    // **The interleaving this guards against**: provider A is tearing down while provider B has taken
    // over. If A's release cleared the adopter unconditionally, B would be left serving nothing —
    // every declaration would report unregistered, and the next one would be queued for a provider
    // that no longer exists.
    //
    // It cannot happen today, by an ordering two files agree on: a provider adopts only after
    // `claimDocument` succeeds and releases before `releaseDocument`, so no second provider can have
    // adopted while a first is tearing down. That is a real guarantee held in `provider.tsx`'s
    // statement order, where a later change could reorder it without anything noticing. This asserts
    // the structural version.
    const { adopt, isAdopter, release } = await import('../../../src/actions/queue.ts');

    const a = { register: () => undefined, withdraw: () => undefined };
    const b = { register: () => undefined, withdraw: () => undefined };

    adopt(a);
    expect(isAdopter(a)).toBe(true);

    adopt(b);
    expect(isAdopter(b)).toBe(true);

    // A tears down LATE, after B took over. It must not speak for B.
    release(a);
    expect(isAdopter(b)).toBe(true);

    // B's own release does end it.
    release(b);
    expect(isAdopter(b)).toBe(false);
  });

  it('withdraws through the adopter that is leaving, not through whoever is current', async () => {
    // The other half: a late release must not ask the LIVE provider to withdraw registrations the
    // leaving one made. Guarded by the same check — a stale release does nothing at all.
    const { adopt, release } = await import('../../../src/actions/queue.ts');
    const withdrawnByB: number[] = [];

    const a = { register: () => undefined, withdraw: () => undefined };
    const b = {
      register: () => undefined,
      withdraw: (entry: { id: number }) => withdrawnByB.push(entry.id),
    };

    registerMcpTool(DEFINITION);
    adopt(a);
    adopt(b);

    release(a);

    expect(withdrawnByB).toEqual([]);
  });
});
