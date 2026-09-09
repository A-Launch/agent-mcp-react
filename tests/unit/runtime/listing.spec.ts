import { describe, expect, it } from 'vitest';
import { deriveListing } from '../../../src/runtime/listing.ts';
import { createOwnershipRecord, type OwnershipRecord } from '../../../src/runtime/ownership.ts';
import type { RegistryEntry } from '../../../src/webmcp/index.ts';

// The derivation, isolated from the socket and the registry so every shape can be constructed.
//
// The property under test is not "the right tools come back" — that is asserted end to end, through
// what an MCP client sees. What these cases pin down is the DIRECTION of the walk, which is invisible
// from outside and is the thing a later refactor changes without noticing.

/** A registry entry as enumeration reports it. */
function entryIn(name: string): RegistryEntry {
  return { name, title: name, description: `the ${name} tool`, origin: 'test' };
}

function recordHolding(...names: string[]): OwnershipRecord {
  const record = createOwnershipRecord();
  for (const name of names) {
    record.add(name, {
      controller: new AbortController(),
      handler: () => undefined,
      declaration: { name, description: name, handler: () => undefined },
    });
  }
  return record;
}

const noDeclarations = () => undefined;

/**
 * A built-in contribution of nothing — this build's real one.
 *
 * Every case in this file is about the registry-and-record intersection, which the built-in table does
 * not change. The built-ins' own listing cases live where a real dispatch can reach them.
 */
const NO_BUILT_INS = { claimed: new Set<string>(), admitted: [] };

describe('the listing is the registry intersected with what we registered', () => {
  it('lists a tool present in both', () => {
    const listing = deriveListing([entryIn('a')], recordHolding('a'), noDeclarations, NO_BUILT_INS);

    expect(listing.tools.map((tool) => tool.name)).toEqual(['a']);
    expect(listing.diverged).toEqual([]);
  });

  it('excludes a registry entry we did not record, and says nothing about it', () => {
    const listing = deriveListing(
      [entryIn('a'), entryIn('foreign')],
      recordHolding('a'),
      noDeclarations,
      NO_BUILT_INS,
    );

    expect(listing.tools.map((tool) => tool.name)).toEqual(['a']);
    // Silently. This is the normal condition of a registry shared with every script in the document,
    // and reporting it would produce a continuous alarm on any page carrying another such script.
    expect(listing.diverged).toEqual([]);
  });

  it('excludes a recorded name the registry does not have, and reports it', () => {
    const listing = deriveListing(
      [entryIn('a')],
      recordHolding('a', 'ghost'),
      noDeclarations,
      NO_BUILT_INS,
    );

    expect(listing.tools.map((tool) => tool.name)).toEqual(['a']);
    // Not silently. We believe we registered something that is not there — a broken invariant rather
    // than an absence, and the asymmetry with the case above is deliberate.
    expect(listing.diverged).toEqual(['ghost']);
  });

  it('answers an empty listing when nothing is registered', () => {
    expect(deriveListing([], recordHolding(), noDeclarations, NO_BUILT_INS).tools).toEqual([]);
  });

  it('carries the declared schema, and an object schema when none was declared', () => {
    const declared = { type: 'object', properties: { country: { type: 'string' } } };
    const listing = deriveListing(
      [entryIn('a'), entryIn('b')],
      recordHolding('a', 'b'),
      (name) => (name === 'a' ? { inputSchema: declared } : undefined),
      NO_BUILT_INS,
    );

    expect(listing.tools.find((tool) => tool.name === 'a')?.inputSchema).toEqual(declared);
    // A tool that declared nothing accepts an object with no properties. MCP admits no other shape for
    // tool arguments, so `type: 'object'` is the protocol's requirement rather than a default we chose.
    expect(listing.tools.find((tool) => tool.name === 'b')?.inputSchema).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('carries a declared title, and omits the key entirely when none was declared', () => {
    // The registry substitutes the tool's NAME for a missing title — `entryIn` reproduces that — so a
    // listing built from the registry entry would publish `title: "b"` for a tool whose author never
    // wrote one, and an agent would have no way to tell that from a real title. The declaration is
    // the only source that can distinguish them.
    const listing = deriveListing(
      [entryIn('a'), entryIn('b')],
      recordHolding('a', 'b'),
      (name) => (name === 'a' ? { title: 'Filter the customer list' } : undefined),
      NO_BUILT_INS,
    );

    expect(listing.tools.find((tool) => tool.name === 'a')?.title).toBe('Filter the customer list');
    // Absent, not present-and-undefined: the protocol layer serializes a key that exists, and
    // `"title": null` on the wire is a different statement from saying nothing.
    expect(listing.tools.find((tool) => tool.name === 'b')).not.toHaveProperty('title');
  });
});

describe('the derivation is recomputed, never remembered', () => {
  it('reflects a changed registry with nothing told to it in between', () => {
    const record = recordHolding('a', 'b');

    expect(
      deriveListing([entryIn('a'), entryIn('b')], record, noDeclarations, NO_BUILT_INS).tools,
    ).toHaveLength(2);

    // No invalidation, no refresh, no notification — there is nothing of the sort to call. If a cache
    // were ever introduced along with a way to clear it, this case would fail, because the clearing
    // call is not here to be made.
    expect(
      deriveListing([entryIn('a')], record, noDeclarations, NO_BUILT_INS).tools.map((t) => t.name),
    ).toEqual(['a']);
    expect(deriveListing([], record, noDeclarations, NO_BUILT_INS).tools).toEqual([]);
  });

  it('is a pure function of its inputs, so the same inputs always give the same answer', () => {
    const record = recordHolding('a');
    const entries = [entryIn('a')];

    const first = deriveListing(entries, record, noDeclarations, NO_BUILT_INS);
    const second = deriveListing(entries, record, noDeclarations, NO_BUILT_INS);

    expect(second.tools).toEqual(first.tools);
    // Distinct objects: nothing was retained between calls and handed back.
    expect(second.tools).not.toBe(first.tools);
  });
});

describe('the direction of the walk', () => {
  it('lets the registry decide, not the record', () => {
    // The inverted implementation — walk the record, look each name up in the registry — produces the
    // same answer for the ordinary case above and differs precisely here: it would list `ghost`,
    // because the record holds it. This case is what turns that refactor red.
    const listing = deriveListing([], recordHolding('ghost'), noDeclarations, NO_BUILT_INS);

    expect(listing.tools).toEqual([]);
    expect(listing.diverged).toEqual(['ghost']);
  });

  it('never lists a name absent from the registry, however many we recorded', () => {
    const listing = deriveListing(
      [entryIn('real')],
      recordHolding('real', 'g1', 'g2'),
      noDeclarations,
      NO_BUILT_INS,
    );

    expect(listing.tools.map((tool) => tool.name)).toEqual(['real']);
    expect([...listing.diverged].sort()).toEqual(['g1', 'g2']);
  });
});
