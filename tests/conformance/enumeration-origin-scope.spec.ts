// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createOwnershipRecord } from '../../src/runtime/ownership.ts';
import { enumerate, register, resetResolutionForTests } from '../../src/webmcp/registry.ts';
import { canonicalRegistry, initializePortabilityLayer, resetRegistry } from './harness.ts';

// **Cross-origin frame access is a declared non-goal (`docs/design.md#non-goals`), and this library
// keeps it by OMISSION — these cases assert the omission.**
//
// Measured against the pinned normative text (`tests/conformance/evidence/webmcp-41d12f0.bs`), and it
// corrects a belief this
// repository held: **registration is per-document, but ENUMERATION is not.** `getTools()` walks the
// traversable navigable's *inclusive descendant navigables* — the whole frame tree — and returns tools
// from every document in it that is same-origin with the caller.
//
// The standard then opens two doors past the same-origin boundary, one on each side:
//
//   `exposedTo`    on registerTool — the origins a tool is offered to
//   `fromOrigins`  on getTools     — the origins an enumeration reaches into
//
// **This library passes neither, and that is the entire mechanism keeping the non-goal true.** There is no check
// to point at, no capability member, no branch — which is exactly why an assertion about ABSENCE is
// the only honest guard.
//
// **And the doors are genuinely open, measured — after two wrong answers about it.** On Chromium 151
// a cross-origin tool that registers with `exposedTo` IS returned to a parent that enumerates with
// `fromOrigins`, and one that omits either is not (`tests/e2e/native-registry/`). Both options work and
// both are required, on top of a Permissions Policy gate whose default allowlist is `'self'`.
//
// So this file is one of three independent things keeping the non-goal true, and the only one this
// library owns.
// The two rejected readings are worth knowing, because each looked settled:
//
//   "both calls are accepted, so the doors are open"   an INVENTED option name is accepted too —
//                                                      WebIDL ignores unknown dictionary members
//   "no cross-origin tool appears, so they do nothing" the frames had been refused by the policy gate
//                                                      and never registered at all
//
// **What this file protects against.** A future author adding `exposedTo` to "make the iframe case
// work" would widen this library from same-origin to cross-origin without touching anything that
// looks like a boundary, and no existing case would notice.
//
// These cases record the arguments actually handed to the registry, rather than reading the source, so
// they fail if the option is added at ANY layer between the declaration and the call.

beforeEach(async () => {
  await resetRegistry();
  resetResolutionForTests();
  await initializePortabilityLayer();
});

/** The declaration used throughout — the content is irrelevant; the CALL is the subject. */
const declaration = {
  name: 'scope.probe',
  description: 'the scope probe tool',
  handler: () => 'ok',
};

describe('registration never offers a tool to another origin', () => {
  it('passes no exposedTo, and passes exactly the two arguments the standard declares', async () => {
    const registry = canonicalRegistry();
    expect(registry, 'the portability layer installed a registry').toBeDefined();
    if (registry === undefined) return;

    const calls: unknown[][] = [];
    const real = registry.registerTool.bind(registry);
    registry.registerTool = ((...args: unknown[]) => {
      calls.push(args);
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as typeof registry.registerTool;

    await register(declaration, new AbortController().signal, createOwnershipRecord());

    expect(calls, 'exactly one registration reached the registry').toHaveLength(1);
    const [descriptor, options] = calls[0] as [Record<string, unknown>, Record<string, unknown>];

    // The descriptor half. `exposedTo` is a member of the registration options in the draft rather
    // than of the tool, so both halves are checked — a reader should not have to know which.
    expect(Object.keys(descriptor)).not.toContain('exposedTo');

    // The options half, and the assertion that carries the weight: `signal` and NOTHING ELSE. A
    // membership check on `exposedTo` alone would pass while some other origin-widening member the
    // draft adds later sat beside it.
    expect(
      Object.keys(options).sort(),
      'the registration options carry the abort signal and nothing else',
    ).toEqual(['signal']);
  });
});

describe('enumeration never reaches into another origin', () => {
  it('calls getTools with no arguments at all', async () => {
    const registry = canonicalRegistry();
    expect(registry).toBeDefined();
    if (registry === undefined) return;

    await register(declaration, new AbortController().signal, createOwnershipRecord());

    const calls: unknown[][] = [];
    const real = registry.getTools.bind(registry);
    registry.getTools = ((...args: unknown[]) => {
      calls.push(args);
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as typeof registry.getTools;

    const entries = await enumerate();
    expect(entries.map((entry) => entry.name)).toContain('scope.probe');

    expect(calls, 'exactly one enumeration reached the registry').toHaveLength(1);
    // **Zero arguments, not "an options object without fromOrigins".** The default is same-origin, so
    // passing nothing is the narrow behaviour; an empty options object would be equivalent today and
    // would be the place a member gets added to later.
    expect(calls[0], 'enumeration passes no options — the default is same-origin').toHaveLength(0);
  });
});
