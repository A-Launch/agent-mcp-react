import { describe, expect, it } from 'vitest';
import {
  CONNECTION_STATUS,
  CONNECTION_TRANSITIONS,
  permitsTransition,
} from '../../../src/react/connection-state.ts';

// The connection machine, asserted as a machine rather than as a table someone reads.
//
// It was declarative until reconnection roughly doubled its edges, and a table nothing consults is a
// comment that drifts from the code without anything failing. `permitsTransition` is what the provider
// calls before publishing, so these are assertions about what the provider can and cannot say.

describe('the transitions it permits', () => {
  it('permits every edge the table declares', () => {
    for (const [from, targets] of Object.entries(CONNECTION_TRANSITIONS)) {
      for (const to of targets) {
        expect(permitsTransition(from as never, to as never)).toBe(true);
      }
    }
  });

  it('refuses every edge it does not', () => {
    const all = Object.values(CONNECTION_STATUS);
    for (const from of all) {
      for (const to of all) {
        if (from === to) continue;
        const declared = CONNECTION_TRANSITIONS[from].includes(to);
        expect(permitsTransition(from, to)).toBe(declared);
      }
    }
  });

  it('refuses a recovery that gives up, because recovery is unbounded', () => {
    // The absence that makes the failure state mean something. If a dropped channel could land there,
    // a page that stopped trying would be indistinguishable to a person from the frozen state this
    // feature exists to remove.
    expect(permitsTransition(CONNECTION_STATUS.reconnecting, CONNECTION_STATUS.error)).toBe(false);
  });

  it('refuses a failed first attempt retrying, because only an established channel is recovered', () => {
    expect(permitsTransition(CONNECTION_STATUS.error, CONNECTION_STATUS.connecting)).toBe(false);
    expect(permitsTransition(CONNECTION_STATUS.error, CONNECTION_STATUS.reconnecting)).toBe(false);
  });

  it('permits recovery to repeat itself, and nothing else to', () => {
    // Each attempt republishes with a higher count, so re-entry is meaningful there. Everywhere else a
    // repeat is a bug worth hearing about — a second `connected` means something connected twice.
    expect(permitsTransition(CONNECTION_STATUS.reconnecting, CONNECTION_STATUS.reconnecting)).toBe(
      true,
    );
    for (const status of Object.values(CONNECTION_STATUS)) {
      if (status === CONNECTION_STATUS.reconnecting) continue;
      expect(permitsTransition(status, status)).toBe(false);
    }
  });

  it('lets every state be torn down, because a page can unmount at any moment', () => {
    for (const status of Object.values(CONNECTION_STATUS)) {
      if (status === CONNECTION_STATUS.disconnected) continue;
      expect(permitsTransition(status, CONNECTION_STATUS.disconnected)).toBe(true);
    }
  });
});
