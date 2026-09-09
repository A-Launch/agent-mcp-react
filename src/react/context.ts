import { createContext } from 'react';
import {
  type AgentCapabilities,
  type CallObservation,
  DENIES_EVERYTHING,
} from '../runtime/index.ts';
import { CONNECTION_STATUS, type McpConnectionState } from './connection-state.ts';
import type { RegistrationGateway } from './registration.ts';

// What the provider publishes to the components beneath it.
//
// **Three contexts, deliberately, split by what changes and when.** The runtime and the gateway never
// change for a provider's lifetime; the connection state changes whenever the network does; the
// capability set changes when an operator hands down a different one. Merging any two would rerender
// every component subscribed to the pair each time either moved, for a value it does not read — and
// this library's whole claim is that it costs an application nothing it did not ask for. A component
// that declares a tool must not rerender because a socket reconnected or a profile changed.
//
// Neither context carries application state, and neither carries the connection URL: a single-use
// ticket lives in that URL, and a context value is exactly the sort of thing that ends up in a
// devtools screenshot.

/**
 * The part that is stable for the provider's whole lifetime.
 *
 * It carries the gateway and **not the runtime**. That is not minimalism: the runtime holds the
 * ownership record every gate is built on, and a value reachable from a component is a value an
 * application can reach around the gates with. The hook needs somewhere to hand a registration, which
 * is all this gives it.
 */
export interface AgentMcpBinding {
  readonly gateway: RegistrationGateway;
  /**
   * Where a failure raised outside a render goes, so that the next render can throw it.
   *
   * Every step of the provider's mount is asynchronous, and a `throw` inside asynchronous work reaches
   * no error boundary — it becomes a rejected promise nobody is holding. Capturing it here and
   * re-throwing during a render is the only path measured to reach a boundary, and it is what makes
   * "fails loudly" a mechanism rather than a wish.
   */
  readonly reportFailure: (failure: unknown) => void;
  /**
   * Where a failure goes that must be reported without taking the application down.
   *
   * A contested tool name in a production build is the case this exists for: the conflict is real and
   * an operator must see it, but tearing a page down because a screen was mounted twice is a worse
   * outcome than the conflict itself. Development still uses `reportFailure`, so an author is stopped.
   *
   * Two destinations rather than a build-mode branch inside every caller: the provider owns which is
   * which, and a hook that had to ask "which build is this?" would be a second reader of a question
   * with one owner.
   */
  readonly reportOperational: (failure: unknown) => void;
  /**
   * Resolves once the application has committed what a handler just changed — the render barrier
   * explained in docs/explanation-commit-and-registration.md.
   *
   * The ONE implementation of the render barrier, used by both call routes: the runtime receives it for
   * `context.afterRender()` on a bridged call, and the descriptor this library puts in the shared
   * registry uses it for an in-page one. Two implementations could wait for different things, and a
   * tool's success would then mean different things depending on who called it: one owner per truth.
   *
   * What it promises and what it deliberately does not are documented on `ToolCallContext.afterRender`,
   * which is where a handler author meets it.
   */
  readonly afterRender: () => Promise<void>;
  /**
   * Opens an observation for a call arriving through the document's shared registry, or returns
   * nothing when nobody is watching.
   *
   * **Deliberately narrow: it OPENS, and it cannot read.** The provider holds a bus with a
   * `subscribe` on it, and putting that here would let any component in the tree read every call's
   * record — including, under `values`, the arguments of calls REFUSED before a handler ran, which
   * are precisely the ones the application would otherwise never see. The same reasoning keeps the
   * runtime out of this binding: a value reachable from a component is a value an application can
   * reach around a gate with.
   *
   * It exists because the registry route does not pass through the runtime at all — the callback the
   * registry holds is built in `useMcpTool` — so this is the only seam by which a page-script call can
   * reach the one projector both routes share.
   */
  readonly observeRegistryCall: (facts: {
    readonly name: string;
    readonly arguments: unknown;
  }) => CallObservation | undefined;
  /**
   * Reports a declaration this library refused before it ever became a tool.
   *
   * Separate from the two failure destinations above because it is not a failure REPORT — the failure
   * already travels those, by the build's own rule. This is the observability half: the same condition
   * described for a consumer that is watching what the library did, rather than for an operator being
   * told something is wrong.
   */
  readonly reportRegistrationEvent: (event: {
    readonly name: string;
    readonly prefix?: string;
    readonly code: string;
  }) => void;
}

/**
 * `undefined` means no provider is above the caller.
 *
 * That is the whole detection mechanism for `MCP_REACT_PROVIDER_MISSING`, and it is why the default
 * value is not a working stub: a stub would let the hook succeed at doing nothing.
 */
export const AgentMcpBindingContext = createContext<AgentMcpBinding | undefined>(undefined);

export const McpConnectionContext = createContext<McpConnectionState>({
  status: CONNECTION_STATUS.disconnected,
});

/**
 * What this connection's agent may reach, published so an application can ask instead of guessing.
 *
 * **It is a reading, never a gate.** The gate lives in the runtime and runs before every handler; an
 * application that hid a button on this value and skipped its own check would have moved a decision
 * out of the one place that is enforced for both call routes. What this is for is the honest UI —
 * showing an operator what the agent can do, explaining a refusal, disabling an affordance that would
 * only fail.
 *
 * Defaults to denying everything, and that is the true answer rather than a convenience: with no
 * provider above the caller there is no connection and no agent, so nothing is reachable. The same
 * value stands in when a supplied set could not be understood — the runtime is denying everything in
 * that state, and a reading that said otherwise would be describing authority nobody granted.
 */
export const McpCapabilitiesContext = createContext<AgentCapabilities>(DENIES_EVERYTHING);
