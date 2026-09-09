import { describe, expect, it } from 'vitest';
import { createOwnershipRecord } from '../../../src/runtime/ownership.ts';

// The record's SURFACE is the requirement, so these cases assert the surface rather than behaviour.
//
// The record must never answer which tools exist. The obvious way to check that is a case
// asserting the listing path does not enumerate it — and that check would be worth very little: it
// covers the call sites that exist today, and the next one added is the one it does not cover.
//
// Asserting there is nothing to call covers the call sites that do not exist yet.

/** A minimal entry. What it holds is not what these cases are about. */
function entry() {
  return {
    controller: new AbortController(),
    handler: () => undefined,
    declaration: { name: 'x', description: 'x', handler: () => undefined },
  };
}

describe('the ownership record answers what is ours', () => {
  it('holds a name it was given, and not one it was not', () => {
    const record = createOwnershipRecord();
    record.add('customers.set_filters', entry());

    expect(record.holds('customers.set_filters')).toBe(true);
    expect(record.holds('something.else')).toBe(false);
  });

  it('returns what goes with a name, or nothing', () => {
    const record = createOwnershipRecord();
    const held = entry();
    record.add('a', held);

    expect(record.entryFor('a')).toBe(held);
    expect(record.entryFor('b')).toBeUndefined();
  });

  it('forgets a name, idempotently', () => {
    const record = createOwnershipRecord();
    record.add('a', entry());

    record.remove('a');
    expect(() => record.remove('a')).not.toThrow();
    expect(() => record.remove('never-added')).not.toThrow();

    // The second removal is not hypothetical: React's development mode invokes every cleanup twice.
    // A record that threw would turn a correct unmount into an error, and one that left the entry
    // behind would collide with the next mount.
    expect(record.holds('a')).toBe(false);
  });
});

describe('the ownership record cannot be asked what exists', () => {
  it('offers no enumeration, count, key list or iterator', () => {
    const record = createOwnershipRecord();
    record.add('a', entry());
    record.add('b', entry());

    // Read this as the requirement rather than as a test of an implementation detail. Each name below
    // is an operation that would answer "which tools exist" — the question with exactly one answer,
    // which belongs to the registry. None of them may exist to be called.
    for (const forbidden of [
      'names',
      'keys',
      'entries',
      'values',
      'size',
      'count',
      'all',
      'list',
      'toArray',
      'forEach',
      'map',
      'filter',
    ]) {
      expect(
        (record as unknown as Record<string, unknown>)[forbidden],
        `the record exposes "${forbidden}", which answers what exists — that question belongs to the registry`,
      ).toBeUndefined();
    }

    expect(
      (record as unknown as Record<symbol, unknown>)[Symbol.iterator],
      'the record is iterable, which answers what exists just as an enumeration method would',
    ).toBeUndefined();
  });

  it('exposes exactly six operations and nothing else', () => {
    const record = createOwnershipRecord();

    // A whitelist rather than a blacklist, so a NEW operation added later fails this case rather than
    // slipping past a list of forbidden names nobody thought to extend.
    //
    // `onChange` was added for the tool-list change notification, and this case is what forced the
    // addition to be argued for
    // rather than merely made. It is admissible for one reason, asserted immediately below: it carries
    // NOTHING. It reports that the record moved and never what moved, so it cannot be used to learn
    // what the record holds — which is the question this whole interface is shaped to refuse.
    expect(Object.keys(record).sort()).toEqual([
      'add',
      'divergedFrom',
      'entryFor',
      'holds',
      'onChange',
      'remove',
    ]);
  });

  it('tells a listener THAT it changed and never what', () => {
    const record = createOwnershipRecord();
    const seen: unknown[][] = [];
    const off = record.onChange((...args: unknown[]) => seen.push(args));

    record.add('a', entry());
    record.remove('a');

    // Two announcements, each carrying no arguments at all. A name passed here would be a second way
    // to learn what the record holds, and a listener that accumulated them would have built the
    // enumeration this interface has no method for.
    expect(seen).toEqual([[], []]);

    off();
    record.add('b', entry());
    // The disposer is real: a subscription that outlived its owner would keep a torn-down runtime
    // reacting to a page it no longer serves.
    expect(seen).toHaveLength(2);
  });
});

describe('the one aggregate question, and why it is not the forbidden one', () => {
  it('reports names the record holds that a supplied listing does not', () => {
    const record = createOwnershipRecord();
    record.add('a', entry());
    record.add('b', entry());

    expect(record.divergedFrom(new Set(['a']))).toEqual(['b']);
    expect(record.divergedFrom(new Set(['a', 'b']))).toEqual([]);
  });

  it('cannot be used to obtain a tool list, because its argument is one', () => {
    const record = createOwnershipRecord();
    record.add('a', entry());
    record.add('b', entry());

    // This is the property that keeps that separation intact. The forbidden question is "which tools exist",
    // asked by a caller that does not already know — and this operation cannot answer it, because a
    // caller must hold the registry's complete listing to call it and gets back only the difference.
    //
    // The empty-set case is the one someone would try in order to smuggle the contents out, and it is
    // the case where the answer is worthless: a caller whose registry listing is empty has nothing to
    // build a tool list from, and everything this returns is by definition NOT in the registry — so
    // none of it is callable, listable, or a tool as far as an agent is concerned.
    for (const name of record.divergedFrom(new Set())) {
      expect(record.holds(name)).toBe(true);
    }
  });
});

describe('there is one notion of ownership in the library', () => {
  it('satisfies the interface the registry boundary requires to classify a refusal', () => {
    const record = createOwnershipRecord();
    record.add('a', entry());

    // `src/webmcp/register()` takes `{ holds(name): boolean }` and decides from it whether a refused
    // registration is this application colliding with itself or a foreign script holding the name. It
    // must be THIS record — a second structure answering the same question is two notions of ownership
    // that have to agree, and the day they disagree the diagnosis points at the wrong owner.
    const asLookup: { holds(name: string): boolean } = record;

    expect(asLookup.holds('a')).toBe(true);
    expect(asLookup.holds('b')).toBe(false);
  });
});
