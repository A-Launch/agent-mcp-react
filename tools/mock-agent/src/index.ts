// The mock agent runtime's public surface, for the CLI in `server.ts` and for the transport suite.
//
// The transport tests import the gateway from here rather than standing up a WebSocket server of
// their own. That is deliberate: a suite that builds its own server tests the server it built, and
// the one an operator actually runs stays unexercised. One owner for "the local gateway", and
// everything else — the CLI, the suites — derived from it.

export type { ChatEvent, ChatEventName, ChatSessions } from './chat.ts';
export { CHAT_EVENT, createChatSessions } from './chat.ts';
export { browserConnectionTransport, connectClient } from './client.ts';
export type { BrowserConnection, Gateway, GatewayOptions } from './gateway.ts';
export { startGateway } from './gateway.ts';
export type { Model, ModelMessage, ModelReply, ModelTool } from './model.ts';
export { createModel } from './model.ts';
export type { MockAgent, MockAgentOptions, TabState, TabSummary } from './runtime.ts';
export { startMockAgent, TAB_STATE } from './runtime.ts';
export type {
  MintedTicket,
  RedemptionOutcome,
  TicketMinter,
  TicketMinterOptions,
  TicketRefusal,
} from './tickets.ts';
export { createTicketMinter, TICKET_REFUSAL } from './tickets.ts';
