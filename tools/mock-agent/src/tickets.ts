import { randomBytes } from 'node:crypto';

// The development ticket minter. Stands in for the application backend that mints connection
// credentials (docs/connecting-to-an-agent.md#minting-a-credential-from-your-backend), which is the piece a
// real deployment owns and this repository deliberately does not ship. The seam it sits behind — the
// provider's `getUrl()`, which returns a URL and never a credential — is the real one, so replacing
// this with a production service is a change of process, not a change of interface.
//
// It enforces single use and expiry for a reason worth stating where the code is: a permissive dev
// gateway accepts a replayed ticket, every local reconnection works, and the first deployment against
// a real gateway fails on the second connection. This is the failure that only shows up somewhere
// expensive, so the cheap environment is the one that must be strict.

// Why a ticket was refused. A closed set declared once as an exported `as const` dictionary with its
// type derived from it, so no boundary re-spells a member: the gateway, the tests and any future
// operator tooling name the same four causes, and none of them may invent a fifth as a string.
export const TICKET_REFUSAL = {
  /** The connection carried no ticket at all. */
  absent: 'absent',
  /** The ticket is not one this minter issued — a forgery, or a restart lost it. */
  unknown: 'unknown',
  /** The ticket was issued and already used. Single use is the point — a ticket authenticates one
   * socket and is never redeemable twice (docs/connecting-to-an-agent.md#minting-a-credential-from-your-backend). */
  spent: 'spent',
  /** The ticket was issued but is past its expiry window. */
  expired: 'expired',
} as const;

export type TicketRefusal = (typeof TICKET_REFUSAL)[keyof typeof TICKET_REFUSAL];

export interface MintedTicket {
  /** The opaque ticket value. Cryptographically random, never derived from anything meaningful. */
  readonly value: string;
  /** Epoch milliseconds after which redemption is refused as `expired`. */
  readonly expiresAt: number;
}

export type RedemptionOutcome =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly refusal: TicketRefusal };

export interface TicketMinterOptions {
  /**
   * How long a minted ticket may sit unused, in milliseconds. A credential should live 30–120 seconds
   * before initial use (docs/connecting-to-an-agent.md#minting-a-credential-from-your-backend); the
   * default is the low end, because a dev loop that needs more than 30 seconds
   * between minting and connecting has a different problem.
   */
  readonly ttlMs?: number;
  /**
   * Clock source, in milliseconds. Injected so an expiry test can advance time without sleeping —
   * a test that waits out a real TTL is a slow test that also cannot assert the boundary precisely.
   */
  readonly now?: () => number;
}

export interface TicketMinter {
  mint(): MintedTicket;
  /** Redeems a ticket, consuming it. A ticket that is accepted here is never accepted again. */
  redeem(value: string | null | undefined): RedemptionOutcome;
  /** How many issued-and-unspent tickets are outstanding. For diagnostics and tests only. */
  readonly outstanding: number;
}

export function createTicketMinter(options: TicketMinterOptions = {}): TicketMinter {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;

  // Issued and not yet redeemed. A redeemed ticket is deleted rather than flagged, so "spent" and
  // "unknown" would be indistinguishable — which is why spent values are kept separately below.
  const live = new Map<string, MintedTicket>();
  // Redeemed values, retained so a replay reports `spent` rather than `unknown`. The two causes point
  // at different bugs — a reused ticket versus a wrong gateway — and collapsing them costs an
  // operator the diagnosis, and an unexpected state has to fail loud rather than collapse into a
  // convenient one.
  const spent = new Set<string>();

  return {
    mint(): MintedTicket {
      const ticket: MintedTicket = {
        value: randomBytes(32).toString('base64url'),
        expiresAt: now() + ttlMs,
      };
      live.set(ticket.value, ticket);
      return ticket;
    },

    redeem(value): RedemptionOutcome {
      if (value === null || value === undefined || value === '') {
        return { accepted: false, refusal: TICKET_REFUSAL.absent };
      }
      if (spent.has(value)) {
        return { accepted: false, refusal: TICKET_REFUSAL.spent };
      }
      const ticket = live.get(value);
      if (ticket === undefined) {
        return { accepted: false, refusal: TICKET_REFUSAL.unknown };
      }
      // Consume before the expiry check: an expired ticket is spent either way, and leaving it live
      // would let a caller retry it forever against a clock that never gets younger.
      live.delete(value);
      spent.add(value);
      if (now() >= ticket.expiresAt) {
        return { accepted: false, refusal: TICKET_REFUSAL.expired };
      }
      return { accepted: true };
    },

    get outstanding(): number {
      return live.size;
    },
  };
}
