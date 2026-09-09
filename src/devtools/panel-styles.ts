// The inspector's own appearance, owned by the library and injected into its shadow root.
//
// **Why the library ships this at all, when it ships no other CSS.** Every other surface this package
// produces is the APPLICATION's markup — a tool is a function, a provider renders its children, and an
// embedder styles its own page. The inspector is the one thing this library draws itself, and until
// this file it drew unstyled: `panel.ts` emitted class names, nothing defined them, and every embedder
// who followed `docs/observing-tool-calls.md` got a wall of raw text in their document flow. Class
// names with nothing behind them are not a styling hook, they are a defect with a plausible excuse.
//
// **Why a shadow root rather than a stylesheet an embedder imports.** This is diagnostic
// infrastructure, and a developer opens it precisely when the page is misbehaving. A stylesheet the
// host has to import makes "broken" the default state and readable the opt-in — exactly backwards for
// a panel whose job is to be legible when nothing else is. Light-DOM styles would also lose to any
// host reset, `* { margin: 0 }`, or a selector as ordinary as `div { font-size: 11px }`. Inside a
// shadow root nothing here leaks out and nothing out there reaches in, so the panel reads the same in
// an application with a full design system and in one with no CSS pipeline at all.
//
// Boundary: this is APPEARANCE only. It positions nothing on the page and sets no `position`, no
// `margin` and no `z-index` — where the panel sits is the host element's business, because the host is
// the one thing this module is given and the only thing an embedder can place. A library that docked
// itself to a corner would be deciding a layout question it cannot see.

/**
 * The panel's stylesheet, as text, injected once per shadow root.
 *
 * A string rather than a `.css` file because this package has no CSS build step and adding one to ship
 * roughly forty rules would be a pipeline for a single asset. It is also what keeps the `/devtools`
 * subpath a single self-contained import: an embedder adds one line and gets a working panel, with no
 * second thing to remember and no bundler configuration that could silently drop the styles and
 * restore exactly the failure this file exists to remove.
 *
 * Both colour schemes are defined, and the dark half is not an inversion — it is a separate set of
 * tokens, because the outcome colours have to stay distinguishable on a dark ground rather than merely
 * flipped. The light block is the bare default so a host that never states a scheme still gets a
 * complete palette (an unset `prefers-color-scheme` is the common case, not an edge one).
 */
export const PANEL_STYLES = `
:host {
  --amr-bg: #ffffff;
  --amr-ink: #12151c;
  --amr-faint: #5b6474;
  --amr-line: #dfe3ec;
  --amr-chip-bg: #f2f4f9;
  --amr-ok: #1c7c4a;
  --amr-bad: #b3261e;
  --amr-warn: #8a5a10;
  --amr-live: #2c55c8;

  display: block;
  /* Contained rather than trusted to be small. The tool list grows with the application and the call
     log holds twenty entries, so an unbounded panel becomes a screenful on a phone — which is the
     shape of the original defect, not a variation of it. */
  max-height: 22rem;
  overflow: auto;
  font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  font-size: 12px;
  line-height: 1.45;
  color: var(--amr-ink);
  background: var(--amr-bg);
  border: 1px solid var(--amr-line);
  border-radius: 10px;
  box-sizing: border-box;
}

@media (prefers-color-scheme: dark) {
  :host {
    --amr-bg: #171b23;
    --amr-ink: #e8ebf2;
    --amr-faint: #9aa3b5;
    --amr-line: #2b3240;
    --amr-chip-bg: #212734;
    --amr-ok: #5cc98d;
    --amr-bad: #f2867e;
    --amr-warn: #e0b45c;
    --amr-live: #8fabf7;
  }
}

/* **Author \`:host { display: block }\` beats the UA \`[hidden] { display: none }\` rule**, so without
   this line a host that sets \`hidden\` on the panel gets nothing: it stays on screen, and the attribute
   looks broken rather than overridden. Measured in Chrome with an isolated probe rather than reasoned
   about — a shadow host carrying only \`:host { display: block }\` computes \`display: block\` while
   hidden, the same host with this rule computes \`none\`, and one carrying no \`:host\` rule at all
   computes \`none\` because the UA rule is then unopposed. */
:host([hidden]) { display: none; }

* { box-sizing: border-box; }

.agent-mcp-inspector {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
}

.agent-mcp-inspector__title {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--amr-faint);
}

/* The status line and the tool count read as one meta row rather than two stacked sentences. */
.agent-mcp-inspector__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  color: var(--amr-faint);
}

.agent-mcp-inspector__tools {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

/* Chips, so ten tools are two rows instead of ten. The name is the identifier an agent calls, so it
   stays monospace and is never abbreviated — a truncated tool name is a name you cannot search for. */
.agent-mcp-inspector__tool {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--amr-chip-bg);
  color: var(--amr-ink);
  white-space: nowrap;
}

.agent-mcp-inspector__heading {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--amr-faint);
  padding-top: 4px;
  border-top: 1px solid var(--amr-line);
}

.agent-mcp-inspector__calls {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.agent-mcp-inspector__empty,
.agent-mcp-inspector__truncated {
  color: var(--amr-faint);
  font-style: italic;
}

/* One row per call. Monospace because these lines are read by comparing them to each other — a tool
   name, a route and a code line up only in a fixed pitch. */
[class*="agent-mcp-inspector__call--"] {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  padding: 3px 7px;
  border-radius: 6px;
  background: var(--amr-chip-bg);
  /* The outcome is carried by a left edge as well as by colour, so the three states stay
     distinguishable without relying on hue alone. */
  border-left: 3px solid var(--amr-faint);
  word-break: break-word;
}

.agent-mcp-inspector__call--result { border-left-color: var(--amr-ok); }
.agent-mcp-inspector__call--error { border-left-color: var(--amr-bad); }
.agent-mcp-inspector__call--running { border-left-color: var(--amr-live); }

/* The ungated notice is nested INSIDE its call row and must not read as another call. It is the line
   most easily misread in the whole panel — a page-script call passed none of the bridge's gates — so
   it gets the warning colour and its own indent rather than blending into the row above it. */
.agent-mcp-inspector__ungated {
  display: block;
  margin-top: 3px;
  padding-left: 8px;
  border-left: 2px solid var(--amr-warn);
  color: var(--amr-warn);
  font-style: normal;
}

/* Not switched on is a different thing from broken, and it is the one message here that a reader may
   meet before anything else works, so it stays plain and readable rather than styled as a failure. */
.agent-mcp-inspector__absent {
  color: var(--amr-faint);
}
`;
