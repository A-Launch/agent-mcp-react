// What an application is told about the connection to the agent, as a closed set: one exported
// dictionary, its type derived from it, and a received string checked for membership rather than cast.
//
// The vocabulary is the connection lifecycle's, documented in docs/connection-lifecycle.md. This
// module decides nothing and performs no I/O: it names states and the transitions between them, so
// that the provider cannot invent one and a case cannot assert against a literal.
//
// **Every member is reachable, and that is a rule rather than an observation.** A state nothing can
// reach is a state a reader has to disprove. `reconnecting` was withheld for exactly that reason,
// and arrived with the mechanism that reaches it.

/** Every state that can be reported. */
export const CONNECTION_STATUS = {
  /** Before the mount effect has run, and after teardown. */
  disconnected: 'disconnected',
  /** An attempt is under way: obtaining the URL, opening the socket, attaching the runtime. */
  connecting: 'connecting',
  /** The runtime is serving over an open channel. */
  connected: 'connected',
  /**
   * An established channel ended and is being recovered, on the backoff schedule in
   * docs/connection-lifecycle.md#the-backoff-schedule.
   *
   * Distinct from `connecting`, which is a page that has never connected — a status surface that
   * collapsed the two could not tell somebody whether their configuration works.
   */
  reconnecting: 'reconnecting',
  /**
   * A FIRST attempt failed. Terminal.
   *
   * Reached only by an attempt that never established a channel, because only an established channel
   * is recovered: one that once opened proves the configuration works, and one that never did may be
   * pointing somewhere that will never answer — where retrying forever would hide a misconfiguration
   * behind a spinner.
   *
   * That is also what keeps this member reachable. Recovery is unbounded, so if a dropped channel
   * could land here too, nothing would ever arrive and this would be a state to disprove.
   */
  error: 'error',
} as const;

export type ConnectionStatus = (typeof CONNECTION_STATUS)[keyof typeof CONNECTION_STATUS];

/** Membership derived from the dictionary, so a new status cannot be half-added. */
const CONNECTION_STATUSES: ReadonlySet<string> = new Set(Object.values(CONNECTION_STATUS));

export function isConnectionStatus(value: string): value is ConnectionStatus {
  return CONNECTION_STATUSES.has(value);
}

/**
 * What the application is handed.
 *
 * **Never carries the connection URL.** A single-use ticket lives in that URL's query string, and an
 * error state is precisely what gets logged, rendered into a status indicator and pasted into an issue
 * — which is why the transport scrubs it before reporting and why nothing here re-introduces it.
 */
export type McpConnectionState =
  | { readonly status: typeof CONNECTION_STATUS.disconnected }
  | { readonly status: typeof CONNECTION_STATUS.connecting }
  | { readonly status: typeof CONNECTION_STATUS.connected; readonly connectedAt: number }
  | {
      readonly status: typeof CONNECTION_STATUS.reconnecting;
      /**
       * Which attempt is under way, counting from 1.
       *
       * **The only thing this state carries.** It deliberately does NOT carry the error that caused the
       * drop: handing a recovery its cause invites a surface to render it as a failure, which is the
       * display this member exists to replace.
       */
      readonly attempt: number;
    }
  | { readonly status: typeof CONNECTION_STATUS.error; readonly error: Error };

/**
 * The transitions that may be performed.
 *
 * **Enforced, not described.** The provider consults this before publishing, so a transition absent
 * here is refused rather than reported — see `permitsTransition`. It was declarative until reconnection
 * roughly doubled its edges, which is when a table nothing reads starts disagreeing with the code.
 *
 * Two absences are decisions:
 *
 *   - **No edge from `reconnecting` to `error`.** Recovery is not bounded by a count, so it does not
 *     give up. A page that gave up is indistinguishable to a person from the frozen error state that
 *     reconnection exists to remove.
 *   - **No edge from `error` to anything but teardown.** A first attempt that failed does not retry.
 */
export const CONNECTION_TRANSITIONS: Readonly<
  Record<ConnectionStatus, readonly ConnectionStatus[]>
> = {
  disconnected: [CONNECTION_STATUS.connecting],
  connecting: [
    CONNECTION_STATUS.connected,
    CONNECTION_STATUS.error,
    // A page can unmount mid-attempt, and does — a route change during a slow handshake is ordinary.
    // The edge was absent before reconnection landed, and invisibly so: teardown published nothing, so
    // nothing ever traversed it. It became reachable when teardown started announcing itself, which is
    // what keeps the machine's memory of the last published state true across an effect being rebuilt.
    CONNECTION_STATUS.disconnected,
  ],
  connected: [CONNECTION_STATUS.reconnecting, CONNECTION_STATUS.disconnected],
  reconnecting: [
    CONNECTION_STATUS.connecting,
    CONNECTION_STATUS.connected,
    CONNECTION_STATUS.disconnected,
  ],
  error: [CONNECTION_STATUS.disconnected],
};

/**
 * Whether the machine permits moving from `from` to `to`.
 *
 * This is what makes the table above a machine rather than a comment. A transition it does not permit
 * is a broken invariant in this library — never something an application did — so the provider reports
 * it to the operator's destination and publishes nothing, rather than publishing a state that the
 * declared machine says cannot happen. An unexpected state fails loud here: nothing is swallowed and
 * no convenience default stands in for it.
 *
 * Re-entering the same state is permitted for `reconnecting` alone, and only there because each
 * attempt republishes with a higher count. Everywhere else a repeat is a bug worth hearing about: a
 * second `connected` means something connected twice.
 */
export function permitsTransition(from: ConnectionStatus, to: ConnectionStatus): boolean {
  if (from === to) return to === CONNECTION_STATUS.reconnecting;
  return CONNECTION_TRANSITIONS[from].includes(to);
}
