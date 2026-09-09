import { AgentMcpProvider, useMcpTabId } from '@agent-mcp/react';
import { createAjvValidator } from '@agent-mcp/react/validation';
import type { ReactNode } from 'react';
import { AGENT_ORIGIN } from './agent-client.ts';
import { Board } from './components/Board.tsx';
import { Chat } from './components/Chat.tsx';
import { useConfirmationSurface } from './components/ConfirmationDialog.tsx';

// The board demonstrator's root: a chat and a board, side by side, both acting on one application.
//
// The whole integration an application author writes is the `AgentMcpProvider` element below. Every
// tool this page exposes is declared elsewhere — by the panel that owns each feature, or by the shell at
// module scope. Nothing is registered here and nothing is registered centrally.
//
// **The chat is inside the provider, and it does not have to be.** It reaches the agent runtime over
// ordinary HTTP and would work outside the tree; it sits here because it needs `useMcpTabId()` to
// address this page. Nothing about the board depends on the chat existing.

/**
 * The validator that makes this page's declared schemas binding.
 *
 * **Not optional in effect.** Every tool here declares an `inputSchema`, and a tool that declares one
 * with no validator installed is not registered at all — absent from `tools/list` and refused at
 * invocation. Built once at module scope, because compiling a schema is the expensive half and a new
 * validator per render would recompile every schema on every render.
 *
 * The other demonstrator additionally ships a hand-written CSP-safe validator, for a page served under a
 * policy whose `script-src` omits `unsafe-eval`. That demonstration has an owner already, and a second
 * copy here would be a second thing to keep correct with no second reader.
 */
const validator = createAjvValidator();

/**
 * Obtains one connection URL per attempt, for the page instance identified by `tabId`.
 *
 * This is the seam a production credential service sits behind. The library takes this FUNCTION and
 * never a credential, so nothing it holds can leak one, and nothing in this file holds a ticket either:
 * it is fetched at the moment it is needed and handed straight over.
 *
 * **The identity is passed in rather than read here**, because this is not a component and `useMcpTabId`
 * is a hook. That shape is also the honest one: attaching the identity is the application's job — the
 * library publishes it and stops, and the transport is forbidden to amend a URL.
 */
async function getUrl(tabId: string): Promise<string> {
  const response = await fetch(`${AGENT_ORIGIN}/ticket`);
  if (!response.ok) {
    throw new Error(`the local agent refused to mint a ticket (${String(response.status)})`);
  }
  // `wsUrl` is the complete URL to dial, ticket included. The only thing added is the tab identifier,
  // which is metadata for routing among tabs and grants no authority: the gateway redeems the ticket
  // first and reads this strictly afterwards, so it cannot enter the admission decision. Never write one
  // by hand — nothing makes a hand-written id unique, and two copies of one page then claim one
  // identity, which this repository's other demonstrator did on 2026-08-25.
  const { wsUrl } = (await response.json()) as { wsUrl: string };
  const dial = new URL(wsUrl);
  dial.searchParams.set('tabId', tabId);
  return dial.toString();
}

function Shell({
  dialog,
  open,
}: {
  readonly dialog: ReactNode;
  readonly open: boolean;
}): ReactNode {
  return (
    <>
      {/*
        `inert` while a confirmation is on screen. The dialog traps a keyboard; this is what also takes
        the background out of the accessibility tree, so a screen reader is not free to browse the page
        behind a question it has not answered. Neither alone makes a dialog modal.
      */}
      <div className="shell" inert={open ? true : undefined}>
        <Chat />
        <Board />
      </div>
      {dialog}
    </>
  );
}

export function App(): ReactNode {
  const confirmation = useConfirmationSurface();
  // One identity for this page instance, minted by the library and stable for the life of the document.
  // Read during render, which is why it is available during render: the URL supplier below closes over
  // it, and a value that only appeared after mount would have to be threaded through an absent case.
  const tabId = useMcpTabId();

  return (
    <AgentMcpProvider
      // An inline supplier costs nothing: the provider holds it in a ref, so a new function identity per
      // render does not tear the connection down.
      connection={{ getUrl: () => getUrl(tabId) }}
      server={{ name: 'composable-board', version: '0.1.0' }}
      validation={{ validator }}
      // **Level 1 only, hardcoded, and the withheld halves are the evidence rather than a precaution.**
      // With semantic-DOM control unavailable, every panel that appears on this board is provably the
      // result of a declared action — the agent had no synthetic click to fall back on, so "the agent
      // composed this" is a claim the configuration itself supports.
      //
      // Required, with no default profile: an absent capability is a denial rather than something the
      // library decides on an application's behalf.
      //
      // What withholding `dom` does NOT do, because a reader copying this should know: it unregisters
      // nothing. Level 1 tools live in the document's shared registry and any script on this page can
      // still invoke them. A capability governs this library's bridge, not the page
      // (docs/explanation-reachability.md#a-capability-governs-the-bridge-not-your-page).
      //
      // Not driven by an environment variable, unlike the other demonstrator: profile switching has an
      // owner there, and this page's subject is composition.
      capabilities={{
        application: true,
        dom: { inspect: false, interact: false },
        evaluate: false,
      }}
      // **How a person answers `panel.<id>.submit`, and BOTH halves are needed.** The surface hands back
      // two things: `dialog` puts the prompt on screen, and `resolver` is what the runtime actually asks.
      // With only the dialog wired, the runtime has no resolver, every confirmation-required call is
      // refused with `MCP_TOOL_CONFIRMATION_UNAVAILABLE`, and the prompt never appears — a page that
      // looks instrumented and is not. That fails safe, which is exactly why nothing but a live run or
      // this line was going to catch it; it was a real defect in the other demonstrator.
      confirmation={{ resolver: confirmation.resolver }}
      // Required, and never the agent: a registry-integrity report is the operator's business.
      onUnexpectedState={(failure) => {
        console.error('[agent-mcp] unexpected state', failure.code, failure.message);
      }}
    >
      <Shell dialog={confirmation.dialog} open={confirmation.open} />
    </AgentMcpProvider>
  );
}
