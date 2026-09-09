// The rendered panel of the in-page inspector (docs/observing-tool-calls.md#the-inspector). Plain DOM,
// no React, no framework.
//
// **Not React, and the reason is operational rather than a rule.** The module rule keeps React in
// `src/react/` alone — but the stronger argument is that a panel built on the renderer it inspects dies
// with the tree it exists to diagnose, and a developer opens this precisely when that tree is
// misbehaving. Plain DOM also means it works unchanged behind a future non-React binding.
//
// It renders and decides nothing. Every value it shows arrives as data; it holds no handler, no
// runtime and no registry, and there is no element in it that can invoke anything.

import type { InspectedCall } from './call-log.ts';

export interface PanelState {
  /** Whether the provider's development channel was found at all. */
  readonly available: boolean;
  readonly snapshot?: {
    readonly connection: { status: string };
    readonly tools: readonly string[];
  };
  readonly calls: readonly InspectedCall[];
  readonly truncated: boolean;
  readonly retained: number;
}

function line(text: string, className?: string): HTMLElement {
  const element = document.createElement('div');
  if (className !== undefined) element.className = className;
  element.textContent = text;
  return element;
}

/**
 * Describes one call in the terms an operator needs, which is never just "denied".
 *
 * Two things are always said out loud. **Which step decided it** — because a capability refusal and an
 * availability refusal send somebody to different places: one is an operator's decision about the whole
 * connection, the other the application's about one tool right now. And **which steps did not run** —
 * because for a call that arrived through the page's own registry that is most of the chain, and a
 * reader who assumed those checks had passed would believe the call was gated when nothing gated it.
 */
function describe(call: InspectedCall): string {
  const took = call.settledAt === undefined ? '' : ` ${call.settledAt - call.startedAt} ms`;
  if (call.outcome === 'running') return `#${call.callId} ${call.name} · ${call.route} · running`;
  if (call.outcome === 'result') {
    return `#${call.callId} ${call.name} · ${call.route}${took} · ok`;
  }
  const why = call.resolution === undefined ? '' : ` (${call.resolution})`;
  const code = call.failureCode === undefined ? 'uncoded' : call.failureCode;
  // **A call that no gate refused was not refused, and saying otherwise invents a fact.** A live run
  // showed this: a cancelled call rendered as "refused at unknown step", which sends a reader looking
  // for a gate that never made a decision. Cancellation is not a refusal — nothing declined the call,
  // the caller stopped waiting for it — and the same is true of an abandoned one.
  if (call.decidedBy === undefined) {
    return `#${call.callId} ${call.name} · ${call.route}${took} · ended — ${code}`;
  }
  return `#${call.callId} ${call.name} · ${call.route}${took} · refused at ${call.decidedBy}${why} — ${code}`;
}

export function renderPanel(host: Element, state: PanelState): void {
  host.replaceChildren();

  const root = document.createElement('section');
  root.className = 'agent-mcp-inspector';
  root.append(line('MCP Agent', 'agent-mcp-inspector__title'));

  if (!state.available) {
    // Reported rather than thrown, and reported as what it is: not switched on, which is different
    // from broken. The two conditions are named so a reader knows which one to change.
    root.append(
      line(
        'No inspection channel. It exists only in a development build AND when the provider was ' +
          'given devtools={{ enabled: true }}.',
        'agent-mcp-inspector__absent',
      ),
    );
    host.append(root);
    return;
  }

  // The status and the tool count are ONE meta row rather than two stacked sentences. Grouping them
  // is not decoration: they are read together ("connected, ten tools") and separately they were two
  // more full-width lines in a panel whose original defect was being a wall of them.
  const meta = document.createElement('div');
  meta.className = 'agent-mcp-inspector__meta';
  meta.append(line(`Status: ${state.snapshot?.connection.status ?? 'unknown'}`));

  const tools = state.snapshot?.tools ?? [];
  meta.append(line(`Tools bridged: ${tools.length}`));
  root.append(meta);
  // Listed, and deliberately not grouped or filtered by control level. Every tool on this page today is
  // Level 1 because `src/dom/` is still a placeholder — encoding that as a permanent truth by, say,
  // labelling the section "Application tools" would be a claim this build cannot support and a
  // relabelling job for whoever lands Level 2.
  // Wrapped in one container so the names flow as chips instead of one per line. Ten tools was ten
  // rows before this; it is two now, and the count no longer decides how much of the page the panel
  // takes.
  const toolList = document.createElement('div');
  toolList.className = 'agent-mcp-inspector__tools';
  for (const name of tools) toolList.append(line(name, 'agent-mcp-inspector__tool'));
  root.append(toolList);

  root.append(line('Recent calls', 'agent-mcp-inspector__heading'));
  const calls = document.createElement('div');
  calls.className = 'agent-mcp-inspector__calls';
  root.append(calls);
  if (state.calls.length === 0) {
    calls.append(line('none yet', 'agent-mcp-inspector__empty'));
  }
  // Most recent first: the call somebody is diagnosing is almost always the last one.
  for (const call of [...state.calls].reverse()) {
    const entry = line(describe(call), `agent-mcp-inspector__call--${call.outcome}`);
    calls.append(entry);
    if (call.route === 'registry' && call.notRun.length > 0) {
      // **Stated prominently, because this is the record most easily misread.** A page-script call
      // passes none of the bridge's gates. Showing it as an ordinary call would let a reader conclude
      // availability or a capability had admitted it, when no such check ever ran.
      entry.append(
        line(
          `page call — bridge gates were NOT applied: ${call.notRun.join(', ')}`,
          'agent-mcp-inspector__ungated',
        ),
      );
    }
  }

  if (state.truncated) {
    // A truncated history is never presented as a complete one.
    calls.append(
      line(
        `showing the most recent ${state.retained}; older calls have been dropped`,
        'agent-mcp-inspector__truncated',
      ),
    );
  }

  host.append(root);
}
