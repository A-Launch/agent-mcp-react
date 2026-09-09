import { useContext } from 'react';
import type { McpConnectionState } from './connection-state.ts';
import { McpConnectionContext } from './context.ts';

/**
 * Reports what the connection to the agent is currently doing.
 *
 * Reads; never acts. There is deliberately no way to connect, disconnect or retry from here — a
 * connection an application could start would be a second owner of the provider's lifecycle, and
 * retrying belongs to the provider's own reconnection schedule.
 *
 * Safe to call with no provider above it, unlike `useMcpTool`. The two are not inconsistent: a
 * missing provider makes a tool declaration a lie, while it makes a connection reading simply true —
 * there is no connection, and `disconnected` says so.
 */
export function useMcpConnection(): McpConnectionState {
  return useContext(McpConnectionContext);
}
