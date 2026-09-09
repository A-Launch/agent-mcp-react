// The browser APIs the design requires (docs/browser-support.md#what-the-design-asks-for), as one
// declared list.
//
// **A constant that is ITERATED rather than six hand-written assertions**, and the reason is this
// suite's whole subject: an API added to the requirement and not to a hand-written case would be
// silently unchecked, which is the class of defect this suite exists to end. Adding a member here adds
// an assertion.
//
// Each entry is expressed as an expression evaluated in the page, because that is the only place the
// question means anything — `AbortSignal.any` existing in Node says nothing about the browser the
// application actually runs in.

export interface RequiredApi {
  readonly name: string;
  /** Evaluated in the page. Must return true when the API is present and usable. */
  readonly probe: string;
  /** Why this library needs it, so a failure says what breaks rather than only what is missing. */
  readonly because: string;
}

export const REQUIRED_APIS: readonly RequiredApi[] = [
  {
    name: 'WebSocket',
    probe: "typeof WebSocket === 'function'",
    because: 'the browser is the MCP server and dials the agent runtime outbound',
  },
  {
    name: 'crypto.randomUUID',
    probe: "typeof crypto?.randomUUID === 'function'",
    because:
      'one page instance mints one identity, and it is unavailable in an insecure context — a page served over plain HTTP from a LAN address, which is exactly how somebody tests on a phone',
  },
  {
    name: 'Promise',
    probe: "typeof Promise === 'function'",
    because: 'every tool call settles asynchronously',
  },
  {
    name: 'Map',
    probe: "typeof Map === 'function'",
    because: 'the ownership record and the built-in table are keyed lookups',
  },
  {
    name: 'AbortController',
    probe: "typeof AbortController === 'function'",
    because: 'a registration ends by aborting its signal, and a call is cancellable',
  },
  {
    name: 'AbortSignal.any',
    probe: "typeof AbortSignal?.any === 'function'",
    because:
      'a call ends for two real reasons — the agent cancelled, or the tool stopped being declared — and a handler must learn about both through ONE signal. This is the newest built-in the bundle requires and it sets the engine floor: Chrome 116, Safari 17.4, Firefox 124',
  },
];
