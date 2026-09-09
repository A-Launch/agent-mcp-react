import { describe, expect, it } from 'vitest';
import type { BuiltInTable } from '../../../src/runtime/built-ins.ts';
import { RUNTIME_FAILURE } from '../../../src/runtime/errors.ts';
import { createOwnershipRecord, type OwnershipRecord } from '../../../src/runtime/ownership.ts';
import { RESOLUTION, refusalFor, resolve } from '../../../src/runtime/resolution.ts';
import type { RegistryEntry } from '../../../src/webmcp/index.ts';

// Step 2 of the gate chain, isolated so all four outcomes can be constructed.
//
// This step exists because the MCP SDK validates nothing: a call naming a tool that appeared in no
// listing is delivered straight to the call handler. Measured, not assumed — so what these cases
// protect is not a nicety but the difference between a refusal and application code running under a
// name nobody registered.

function entryIn(name: string): RegistryEntry {
  return { name, title: name, description: name, origin: 'test' };
}

/**
 * A table with no built-ins — this build's real one, and what every case here means by "a name".
 *
 * Named rather than inlined at every call site, because an empty table IS the production state; a bare
 * `new Map()` repeated a dozen times reads as a placeholder somebody forgot to fill.
 */
const NO_BUILT_INS: BuiltInTable = new Map();

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

describe('a name resolves to exactly one of four things', () => {
  it('is ours when both the registry and the record have it', () => {
    expect(resolve('a', [entryIn('a')], recordHolding('a'), NO_BUILT_INS)).toBe(RESOLUTION.owned);
  });

  it('is foreign when the registry has it and we did not record it', () => {
    expect(resolve('a', [entryIn('a')], recordHolding(), NO_BUILT_INS)).toBe(RESOLUTION.foreign);
  });

  it('is unknown when neither has it', () => {
    expect(resolve('a', [], recordHolding(), NO_BUILT_INS)).toBe(RESOLUTION.unknown);
  });

  it('is diverged when we recorded it and the registry does not have it', () => {
    expect(resolve('a', [], recordHolding('a'), NO_BUILT_INS)).toBe(RESOLUTION.diverged);
  });

  it('treats a withdrawn tool as unknown rather than as still ours', () => {
    // Withdrawal removes it from both sides. The important half is what happens next: a call arriving
    // afterwards is refused, because an agent may hold a list from before and absence from a listing
    // is not an access control.
    const record = recordHolding('a');
    record.remove('a');

    expect(resolve('a', [], record, NO_BUILT_INS)).toBe(RESOLUTION.unknown);
  });
});

describe('each outcome is distinguishable from the reported failure alone', () => {
  it('gives foreign, unknown and diverged three different causes', () => {
    const causes = (['foreign', 'unknown', 'diverged'] as const).map(
      (outcome) => refusalFor('a', outcome).code,
    );

    expect(new Set(causes).size).toBe(3);
    expect(causes).toEqual([
      RUNTIME_FAILURE.nameHeldByForeignOwner,
      RUNTIME_FAILURE.toolNotFound,
      RUNTIME_FAILURE.ownershipDiverged,
    ]);
  });

  it('names the tool the failure concerns', () => {
    for (const outcome of ['foreign', 'unknown', 'diverged'] as const) {
      const refusal = refusalFor('customers.set_filters', outcome);
      expect(refusal.toolName).toBe('customers.set_filters');
      expect(refusal.message).toContain('customers.set_filters');
    }
  });

  it('says something an operator can act on differently for each', () => {
    // The three demand different responses: register the tool, escalate to whoever owns the other
    // script, or investigate this library's own bookkeeping. A single "not found" would hide which.
    expect(refusalFor('a', 'foreign').message).toMatch(/does not own/);
    expect(refusalFor('a', 'unknown').message).toMatch(/no tool named/);
    expect(refusalFor('a', 'diverged').message).toMatch(/not in the document's registry/);
  });
});

describe('resolution decides from the two authorities and nothing else', () => {
  it('reaches the same verdict without a registry, a socket or a document', () => {
    // The whole function is a decision over two supplied inputs, which is what lets every outcome be
    // exercised here rather than only through a live page. A resolution step that read the registry
    // itself would be a decision entangled with I/O, and the diverged case would be unreachable.
    expect(resolve('a', [entryIn('a')], recordHolding('a'), NO_BUILT_INS)).toBe(RESOLUTION.owned);
    expect(typeof globalThis.document).toBe('undefined');
  });
});
