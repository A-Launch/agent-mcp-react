import {
  AgentMcpProvider,
  CONNECTION_STATUS,
  useMcpConnection,
  useMcpTabId,
} from 'agent-mcp-react';
import { domInspectTools, domInteractTools } from 'agent-mcp-react/dom';
import { runtimeEvaluateTool } from 'agent-mcp-react/evaluate';
import { createAjvValidator } from 'agent-mcp-react/validation';
import type { ReactNode } from 'react';
import { selectedProfile } from './capability-profile.ts';
import { useConfirmationSurface } from './components/ConfirmationDialog.tsx';
import { McpInspector } from './components/McpInspector.tsx';
import { createCspSafeValidator } from './csp-safe-validator.ts';
import { RoutedScreens } from './router.tsx';
import { DashboardProvider } from './state/dashboard.tsx';

// The demonstrator's root: a filterable customer book that an agent drives through the same
// transitions its own controls use.
//
// The whole integration an application author writes is the `AgentMcpProvider` element below. There
// is no feature detection, no environment conditional, and no setup step that has to run before React
// does. Every tool this page exposes is declared by the component that owns the feature — nothing is
// registered here, and nothing is registered centrally.
//
// Nesting order matters and is not arbitrary: `DashboardProvider` is INSIDE `AgentMcpProvider`,
// because the components that call `useMcpTool` need both, and a tool declared above the MCP provider
// would throw rather than quietly register nowhere.

/**
 * The validator that makes this page's declared schemas binding.
 *
 * **Not optional in effect.** Every tool here declares an `inputSchema`, and a tool that declares one
 * with no validator installed is not registered at all — it would be absent from `tools/list` and
 * refused at invocation. Before this existed, each handler opened with its own hand-written checks;
 * that code is gone, and this line is what replaces it.
 *
 * Built once at module scope: compiling a schema is the expensive half, and a new validator per render
 * would recompile every schema on every render.
 */
/**
 * **Which validator this page installs, and why there is a choice at all.**
 *
 * `createAjvValidator` is the bundled one and the right default — but Ajv compiles schemas with
 * `new Function`, so it throws under a Content-Security-Policy whose `script-src` omits
 * `unsafe-eval`. And this library will not register a tool whose declared schema has no working
 * validator, so under that policy the page would register NOTHING and an agent would see an empty
 * application. Measured; recorded in `docs/issues/validator-requires-unsafe-eval.md`.
 *
 * A page served with `?csp=strict` installs the CSP-safe one instead. That is not a trick for a test:
 * it is what any application under a strict policy must do, and `SchemaValidator` is an interface the
 * application supplies precisely so it can.
 */
const validator =
  typeof location !== 'undefined' && location.search.includes('csp=strict')
    ? createCspSafeValidator()
    : createAjvValidator();

/** Where the local agent runtime lives. The `:450xx` block; see the run-dev-stack skill. */
const AGENT_ORIGIN = 'http://localhost:45000';

/**
 * Whether the in-page inspector and `window.__AGENT_MCP__` are installed.
 *
 * `AMR_INSPECTOR=0` turns them off. Defaults to ON in this demonstrator because inspecting it is the
 * point — an embedder copying this line should not: the provider's own default is off, and both this
 * flag AND a development build are required before the channel exists at all.
 */
const inspectorEnabled = import.meta.env.AMR_INSPECTOR !== '0';

/**
 * Obtains one connection URL per attempt, for the page instance identified by `tabId`.
 *
 * This is the seam a production credential service sits behind. The library takes this FUNCTION and
 * never a credential, so nothing it holds can leak one — and nothing in this file holds a ticket
 * either: it is fetched at the moment it is needed and handed straight over.
 *
 * **The identity is passed in rather than read here**, because this function is not a component and
 * `useMcpTabId` is a hook. That shape is also the honest one: attaching the identity is the
 * application's job. The library publishes it and stops — the transport is forbidden to amend a URL,
 * so nothing but application code can put it there.
 */
async function getUrl(tabId: string): Promise<string> {
  const response = await fetch(`${AGENT_ORIGIN}/ticket`);
  if (!response.ok) {
    throw new Error(`the local agent refused to mint a ticket (${response.status})`);
  }
  // `wsUrl` is already the complete URL to dial, ticket included. The only thing added here is the tab
  // identifier, which is metadata for routing among tabs and grants no authority whatsoever — the
  // gateway never reads it to decide whether to accept a connection.
  //
  // **It used to be the literal string `dashboard`, and that was a real defect.** Two copies of this
  // page then claimed one identity, and an agent naming it was answered by whichever connected first.
  // Nothing makes a hand-written id unique, which is why the library mints one per page instance.
  const { wsUrl } = (await response.json()) as { wsUrl: string };
  const dial = new URL(wsUrl);
  dial.searchParams.set('tabId', tabId);
  return dial.toString();
}

function ConnectionIndicator(): ReactNode {
  const connection = useMcpConnection();
  // **The page's own identity, published so a test can address THIS page rather than guess.** It is
  // metadata and never a credential — the gateway reads it only after redeeming a ticket — and it
  // already travels in the URL this page dials. An attribute rather than visible text: a person has
  // no use for it, and a harness that infers which tab is its own from a global list is a harness
  // that addresses somebody else's page.
  const tabId = useMcpTabId();

  // **Every member named, rather than a default that renders the raw word.** The status set widened
  // when reconnection landed, and this rendered `reconnecting` as bare text until it was updated — the
  // compiler could not catch it, because a bare string is a valid thing to render. A surface an
  // embedder copies should show what the next member will need too: a name.
  const label =
    connection.status === CONNECTION_STATUS.error
      ? `not connected — ${connection.error.message}`
      : connection.status === CONNECTION_STATUS.reconnecting
        ? // A recovery in progress, never a failure. The attempt number is what tells a person the page
          // is working rather than stuck, which is the whole reason this state carries one.
          `reconnecting — attempt ${String(connection.attempt)}`
        : connection.status;

  return (
    <p
      className={`connection connection-${connection.status}`}
      data-testid="connection"
      data-tab-id={tabId}
    >
      <span className="dot" aria-hidden="true" />
      agent connection: <strong>{label}</strong>
    </p>
  );
}

/**
 * The Level 2 read tools, built once at module scope.
 *
 * Built here rather than in the render for the same reason `validator` is: these factories compile
 * their tools' input schemas, and doing that per render would recompile a constant on every keystroke.
 * The provider holds the array it is given, so a new identity each render would also make every
 * reconnection serve a different array object for no reason.
 *
 * **The write half is supplied only when the operator granted it**, which is a demonstration rather
 * than an optimisation: the two conditions are independent, so this page shows an embedder deciding
 * the IMPORT half deliberately instead of shipping everything and relying on the gate. An operator on
 * the `inspect` profile gets a build whose agent can describe the page and a page that contains no
 * write code at all.
 */
/** Read once at module scope, because the tool set below is decided from it. */
const capabilityProfile = selectedProfile();

const domTools = [
  ...domInspectTools({ validator }),
  ...(capabilityProfile.grants.dom.interact ? domInteractTools({ validator }) : []),
  // **Level 3, and this import is deliberate in a way the others are not.** As
  // docs/javascript-evaluation.md sets out, this is equivalent to arbitrary code execution in this
  // page's origin — the DOM, application globals, storage,
  // same-origin requests, and any non-HttpOnly credential this page can reach.
  //
  // It is constructed ONLY under the profile that grants it. The capability alone would be enough to
  // refuse every call, so this is belt and braces — but it is the belt that matters, because a build
  // that does not construct the tool cannot be talked into offering it by any later change to a
  // capability. Never enabled to unblock a task: the three levels are separate layers, and nothing
  // short of an explicit `evaluate` grant reaches this one.
  ...(capabilityProfile.grants.evaluate ? runtimeEvaluateTool({ validator }) : []),
];

export function App(): ReactNode {
  const confirmation = useConfirmationSurface();
  // One identity for this page instance, minted by the library and stable for the life of the
  // document. Read during render, which is the whole reason it is available during render: the URL
  // supplier below closes over it, and a value that only appeared after mount would have to be
  // threaded through an absent case first.
  const tabId = useMcpTabId();

  // Read once per render from the operator's choice. A wrong value THROWS rather than falling back:
  // a typo that quietly became `standard` would grant capabilities somebody believed they had
  // withheld, and would look exactly like a working deployment.
  const capabilities = capabilityProfile;

  return (
    <AgentMcpProvider
      // An inline supplier costs nothing: the provider holds it in a ref, so a new function identity
      // each render does not tear the connection down.
      connection={{ getUrl: () => getUrl(tabId) }}
      server={{ name: 'customer-dashboard', version: '0.1.0' }}
      validation={{ validator }}
      // What this page's agent may reach. Required, with no default profile: an absent capability is a
      // denial rather than something the library decides on an application's behalf.
      //
      // Chosen by the operator through `AMR_CAPABILITIES`, defaulting to Level 1 only — the
      // application's own tools, the same actions the human UI calls. That is the recommended shape,
      // and the reason the library exists: a flow an agent needs is instrumented, not clicked at.
      //
      // The `none` profile exists so a capability REFUSAL can be watched in a real browser. Until it
      // was wired, every tool here was Level 1 and there was nothing an agent could be refused BY —
      // so every capability denial in this repository was covered by the suites and by nothing else.
      //
      // What it does NOT do, because a reader copying this should know: withholding `application`
      // would refuse the AGENT's calls and leave every tool below registered in the document, where
      // any script on this page can still invoke it. A capability governs this library's bridge.
      capabilities={capabilities.grants}
      // Level 2, the READ half — `dom.snapshot` and `dom.get_text` (docs/dom-inspection.md). This is
      // the whole of what
      // an embedder writes to enable it, and there are TWO conditions rather than one:
      //
      //   this import          puts the code in the bundle
      //   `dom.inspect`        admits the call
      //
      // Neither implies the other, and that is deliberate. A build that never imports the subpath
      // contains none of the snapshot code, so an application that does not want Level 2 does not ship
      // it — and an operator granting the capability without this line gets `MCP_TOOL_NOT_FOUND`,
      // because a granted capability is not a tool.
      //
      // These are NEVER registered. They do not enter the document's shared tool registry in any
      // configuration, including this one — anything in that registry is callable by every script on
      // the page with not one gate in the path (docs/design.md#security-invariants, invariant 16).
      //
      // **And this is a FALLBACK, which is worth saying in the file an embedder copies.** Every flow
      // this page cares about has a Level 1 tool, and reaching for `dom.snapshot` where one of those
      // would do is a regression rather than a convenience: Level 2 is the fallback for a flow nobody
      // instrumented, never a shortcut past one somebody did. It is here so an agent
      // can describe a screen nobody instrumented — and so a person can watch the two halves of the
      // DOM capability behave differently, with `AMR_CAPABILITIES=inspect`.
      builtInTools={domTools}
      // How a person answers a tool that declares `confirmation: 'required'` — here, `account.set_health`.
      //
      // **Rendering the dialog is not enough, and its absence here was a real defect.** The surface
      // hands back two things and BOTH are needed: `dialog` puts the prompt on screen, and `resolver`
      // is what the runtime actually asks. With only the first wired, the runtime has no resolver, so
      // every confirmation-required call is refused with `MCP_TOOL_CONFIRMATION_UNAVAILABLE` and the
      // dialog never appears — a page that looks instrumented and is not. That fails safe, which is
      // why nothing but a live run or this line was going to catch it.
      confirmation={{ resolver: confirmation.resolver }}
      // Required, and never the agent: a registry-integrity report is the operator's business. In a
      // real application this goes to whatever collects operational alarms.
      // Installs `window.__AGENT_MCP__` — but only because this is a development build AND this says
      // so. Both conditions, so an application that leaves this on does not ship a debug channel.
      // Driven by `AMR_INSPECTOR`, which was another variable `.env.example` documented and nothing
      // read; it defaults to on here because this page exists to be inspected.
      devtools={{ enabled: inspectorEnabled }}
      onUnexpectedState={(failure) => {
        console.error('[agent-mcp] unexpected state', failure.code, failure.message);
      }}
      // What an agent actually did, and which gate decided it (docs/observing-tool-calls.md). All four
      // are optional and cost
      // nothing when absent: with no observer supplied and no inspector mounted, the library builds no
      // record at all — no id, no timestamp, nothing copied.
      //
      // Note what is NOT passed: `observability={{ payloads: 'values' }}`. The default is metadata in
      // every build including this dev server, and a demonstrator that opted into values would be
      // teaching the wrong default to everyone who copies it. A call refused before the handler never
      // reaches this application, so an event carrying its arguments would hand this page data it
      // would otherwise never have seen — and an argument that failed validation is the likeliest of
      // all to be malformed or secret.
      onToolCall={(event) => {
        console.info('[agent-mcp] call', event.callId, event.name, `via ${event.route}`);
      }}
      onToolResult={(event) => {
        console.info('[agent-mcp] result', event.callId, event.name);
      }}
      // The document's registry is shared with every script on the page, so "the registry changed" and
      // "what the agent can see changed" are different questions. The flag answers the second, and a
      // widget or an extension registering its own tool answers it `false`.
      onRegistryChange={(event) => {
        console.info(
          '[agent-mcp] registry',
          event.agentVisibleMoved ? 'agent-visible set MOVED' : 'agent-visible set unchanged',
          `${event.tools.length} bridged`,
        );
      }}
      // A declaration refused before it ever became a tool. There is no call to attach this to and
      // never will be — a reserved prefix is refused at declaration — so without it an author sees a
      // tool simply missing with nothing to explain why.
      onRegistration={(event) => {
        console.error('[agent-mcp] declaration refused', event.name, event.prefix, event.code);
      }}
      onToolError={(event) => {
        // The whole point of the surface: not "it was denied", but WHICH step denied it. A capability
        // refusal and an availability refusal are different problems with different fixes.
        const decided = event.gates.find((gate) => gate.outcome === 'refused');
        // The steps that never executed, named. For a call that arrived through the page's own
        // registry this is the whole point: capability, availability and confirmation govern this
        // library's BRIDGE, so they did not run — and a surface that showed them as passed would tell
        // an operator a check admitted a call that no check ever saw.
        const skipped = event.gates
          .filter((gate) => gate.outcome === 'notRun')
          .map((gate) => gate.step)
          .join(', ');
        console.warn(
          '[agent-mcp] refused',
          event.callId,
          event.name,
          `via ${event.route}`,
          `at ${decided?.step ?? 'unknown'}`,
          event.resolution ?? '',
          event.failure && 'code' in event.failure ? event.failure.code : 'uncoded',
          skipped === '' ? '' : `| did not run: ${skipped}`,
        );
      }}
    >
      <DashboardProvider>
        {confirmation.dialog}
        {/*
          **`inert` while a decision is pending, which is the other half of being modal.** The dialog
          traps Tab on its own, but a focus trap says nothing to a screen reader browsing by heading or
          landmark — it would be free to read and operate the page behind a question nobody has
          answered. `inert` removes this subtree from the accessibility tree and from hit-testing
          together, so the background is unavailable by every route rather than only by keyboard.
        */}
        <div className="app" inert={confirmation.open}>
          <header className="app-head">
            <div>
              <h1>Customer book</h1>
              <p className="muted">
                A filterable SaaS page. Everything an agent can do here, a person can do too.
              </p>
            </div>
            <ConnectionIndicator />
          </header>

          {/*
            The in-page inspector (docs/observing-tool-calls.md#the-inspector). Imported from the
            `/devtools` subpath, mounted explicitly, and handed a host element and nothing else — it
            holds no runtime, no gateway and no tool
            handler, so it can explain a denied call and can never make one.
          */}
          <McpInspector />

          {/*
            The routed screens. Step 11 of the acceptance scenario
            (docs/design.md#the-acceptance-scenario) is a real navigation, and steps 12-13 are its
            consequence: leaving `/` unmounts the components that declared the customer tools, so the
            agent's
            listing shrinks and a later call to one of them is REFUSED rather than merely absent.

            The router is created at MODULE SCOPE (see `router.tsx`), which is what lets the shell's
            navigation tool bind a real `navigate` before React has mounted.
          */}
          <RoutedScreens />
        </div>
      </DashboardProvider>
    </AgentMcpProvider>
  );
}
