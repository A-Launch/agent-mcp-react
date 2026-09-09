import { useContext } from 'react';
import type { AgentCapabilities } from '../runtime/index.ts';
import { McpCapabilitiesContext } from './context.ts';

/**
 * Reports what the connected agent may reach, as the provider's operator granted it.
 *
 * **A reading, never a gate, and the distinction is the whole of this hook's contract.** Every
 * capability is enforced in the runtime, before a handler is entered, on both call routes — see
 * docs/reference-capabilities.md#the-gate-chain.
 * This answers the same question for the UI: what to show an operator, how to explain a refusal, which
 * affordance would only ever fail. An application that used this INSTEAD of its own domain check would
 * have moved a decision out of the place that is actually enforced — and the shared-registry route
 * does not pass through it at all, so the check would silently stop applying to every page script.
 *
 * What it returns is the set the gate is reading, frozen at its source, so this cannot become a way to
 * widen authority from application code: authority only ever narrows, and no configuration, adapter,
 * devtool or handler may widen what the provider granted. Writing to it throws rather than granting
 * `evaluate`.
 *
 * Safe to call with no provider above it, unlike `useMcpTool`, and the two are not inconsistent: a
 * missing provider makes a tool declaration a lie, while it makes this reading simply true — there is
 * no agent, so nothing is reachable, and a set that denies everything says exactly that.
 *
 * It rerenders the caller when the granted set changes and at no other time. Its own context rather
 * than the binding's: a component declaring a tool must not rerender because an operator changed a
 * profile it never reads.
 */
export function useMcpCapabilities(): AgentCapabilities {
  return useContext(McpCapabilitiesContext);
}
