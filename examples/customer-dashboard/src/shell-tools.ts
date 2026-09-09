import { bindNavigationTool } from 'agent-mcp-react/router';
import { pathOf, router, SCREEN } from './router.tsx';

// A tool the application SHELL owns, declared at module scope — before React mounts, and outside every
// component (docs/tools-outside-react.md).
//
// **This is the demonstrator's one adapter, and it is here rather than in a component on purpose.**
// Everything else this page exposes is declared by the component that owns the feature, which is the
// right default: registration follows the component's lifetime, so a tool disappears exactly when its
// feature leaves the page. This one has no feature and no component — the address bar belongs to the
// document, not to a screen — so it is declared where its owner actually is.
//
// What that buys, and it is visible in the demonstration: this tool is in `tools/list` from the moment
// the page connects, before anything has rendered, and it SURVIVES the provider unmounting and
// remounting. Its owner did not unmount.
//
// It is an ordinary Level 1 tool. There is no navigation capability — an earlier version of this
// library's source claimed there was — so an operator who wants this withheld declares it unavailable
// rather than expecting a gate to do it.

export const navigateScreens = bindNavigationTool({
  name: 'shell.go_to',
  description:
    'Moves between this dashboard’s screens. Declared by the application shell rather than by any ' +
    'screen, so it is available before anything renders and survives every navigation — including ' +
    'the ones it performs.',
  inputSchema: {
    type: 'object',
    properties: {
      screen: {
        type: 'string',
        // DERIVED from the screen vocabulary, never hand-listed. A tool whose enum and whose router
        // disagree advertises a screen that does not exist, and the refusal an agent gets back names
        // a permitted value that goes nowhere. The vocabulary is declared once and every use of it is
        // derived, never spelled again.
        enum: Object.values(SCREEN),
        description: 'Which screen to show.',
      },
    },
    required: ['screen'],
    additionalProperties: false,
  },
  // The path is BUILT here from a closed vocabulary rather than taken from the agent
  // (docs/store-adapters.md#navigation-is-level-1). An agent
  // that could supply a path could navigate anywhere the router accepts, which is a wider surface than
  // this tool's description claims — and the enum above is what an agent reads to choose.
  //
  // Looked up rather than spelled. This line used to read `input.screen === 'activity' ? '/activity'
  // : '/'`, which was a second owner of both the vocabulary and the paths: renaming a route left this
  // tool navigating to an unmatched path AND still reporting success, because a navigation to nowhere
  // resolves normally.
  toPath: (input) => pathOf(input.screen),
  // **A REAL navigate, and this is what the data router was for.** `router.navigate` is a method on
  // an object created at module scope — it exists before React mounts, which is the only reason this
  // tool can be declared out here at all. The usual alternative is a mutable ref a component fills in
  // an effect, and a tool built on one would be registered and non-functional until something
  // rendered: a tool that lies about being ready.
  //
  // Until this feature, this example bound a stub that recorded a path into a variable, because the
  // page had nowhere to go. It was an adapter with no demonstrator.
  navigate: (path) => router.navigate(path),
  selectResult: () => ({ screen: router.state.location.pathname }),
});
