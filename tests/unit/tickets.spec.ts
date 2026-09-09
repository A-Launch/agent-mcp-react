import { createTicketMinter, TICKET_REFUSAL } from 'agent-mcp-mock-agent';
import { describe, expect, it } from 'vitest';

// The ticket minter's rules, asserted without a socket. `tests/transport/` proves the gateway applies
// them; this layer proves the rules themselves, which is the only place the *cause* of each refusal
// can be pinned down cheaply.
//
// Every case here asserts a named refusal rather than a falsy result. Four causes point at four
// different bugs, and a minter that returns `false` for all of them is a minter whose failures an
// operator cannot act on. A closed set of causes is declared once and matched against, and an
// unexpected state is named rather than collapsed into a falsy value.

describe('the development ticket minter', () => {
  it('accepts a freshly minted ticket exactly once', () => {
    const minter = createTicketMinter();
    const ticket = minter.mint();

    expect(minter.redeem(ticket.value)).toEqual({ accepted: true });
    expect(minter.redeem(ticket.value)).toEqual({
      accepted: false,
      refusal: TICKET_REFUSAL.spent,
    });
  });

  it('names an absent ticket separately from an unknown one', () => {
    const minter = createTicketMinter();

    for (const absent of [null, undefined, '']) {
      expect(minter.redeem(absent)).toEqual({ accepted: false, refusal: TICKET_REFUSAL.absent });
    }
    expect(minter.redeem('a-value-this-minter-never-issued')).toEqual({
      accepted: false,
      refusal: TICKET_REFUSAL.unknown,
    });
  });

  it('refuses a ticket at its expiry, not merely past it', () => {
    let clock = 500;
    const minter = createTicketMinter({ ttlMs: 100, now: () => clock });
    const ticket = minter.mint();

    clock = ticket.expiresAt;

    // The boundary is asserted at the exact instant rather than well beyond it. An off-by-one in the
    // comparison survives a test that jumps an hour ahead.
    expect(minter.redeem(ticket.value)).toEqual({
      accepted: false,
      refusal: TICKET_REFUSAL.expired,
    });
  });

  it('consumes an expired ticket rather than leaving it retryable', () => {
    let clock = 0;
    const minter = createTicketMinter({ ttlMs: 10, now: () => clock });
    const ticket = minter.mint();
    clock = 100;

    expect(minter.redeem(ticket.value)).toEqual({
      accepted: false,
      refusal: TICKET_REFUSAL.expired,
    });
    // A second attempt reports `spent`, not `expired`: the value is gone. Leaving it live would let a
    // caller retry forever against a clock that never gets younger.
    expect(minter.redeem(ticket.value)).toEqual({
      accepted: false,
      refusal: TICKET_REFUSAL.spent,
    });
    expect(minter.outstanding).toBe(0);
  });

  it('mints values that are unguessable and distinct', () => {
    const minter = createTicketMinter();
    const values = new Set(Array.from({ length: 200 }, () => minter.mint().value));

    expect(values.size).toBe(200);
    // Long, URL-safe and carrying nothing derived from the request. A ticket that encodes a counter,
    // a timestamp or a tab id is a ticket an attacker can construct.
    for (const value of values) expect(value).toMatch(/^[\w-]{40,}$/);
  });
});
