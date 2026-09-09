// The React binding's front door: the provider, the hooks, and the types an application names.
//
// What this module owns: binding React's component lifecycle to the registry's registration lifecycle,
// and nothing else. It holds no policy, no protocol and no application state.
//
// **The gateway, the context and the runtime are not exported.** The gateway is an ordering structure
// with no meaning outside a provider; the runtime carries the ownership record every gate is built on,
// and a public path to it is a public path around them.

export type { ConnectionStatus, McpConnectionState } from './connection-state.ts';
export {
  CONNECTION_STATUS,
  CONNECTION_TRANSITIONS,
  isConnectionStatus,
} from './connection-state.ts';
export type { ReactFailureCode, ReactRefusedCode, UnexpectedStateReport } from './errors.ts';
export { AgentMcpReactError, isReactRefusedCode, REACT_REFUSED } from './errors.ts';
export type {
  McpCallFailure,
  McpObservedCall,
  McpRegistrationEvent,
  McpRegistryChangeEvent,
  McpToolCallEvent,
  McpToolErrorEvent,
  McpToolResultEvent,
} from './observability.ts';
export type { AgentMcpProviderProps } from './provider.tsx';
export { AgentMcpProvider } from './provider.tsx';
export { useMcpCapabilities } from './use-mcp-capabilities.ts';
export { useMcpConnection } from './use-mcp-connection.ts';
export type { McpStateDefinition } from './use-mcp-state.ts';
export { STATE_TOOL_SUFFIX, useMcpState } from './use-mcp-state.ts';
export { useMcpTabId } from './use-mcp-tab-id.ts';
export type { McpToolDefinition } from './use-mcp-tool.ts';
export { useMcpTool } from './use-mcp-tool.ts';
