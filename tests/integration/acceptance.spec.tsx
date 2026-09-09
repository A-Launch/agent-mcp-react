// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_FAILURE } from '../../src/runtime/index.ts';
import {
  type Application,
  listedNames,
  startApplication,
  stopApplication,
  until,
} from './harness.tsx';

// **The acceptance scenario (docs/design.md#the-acceptance-scenario), and the only test in this
// repository that asserts the product rather than a mechanism.**
//
// Every other suite proves one thing works. This one proves they work TOGETHER, in the order a real
// session takes: an agent finds a tool, uses it, the screen changes, the agent reads the change back,
// the feature leaves the screen, and the next call is refused.
//
// ---
//
// **FOURTEEN CASES OVER ONE SHARED SETUP, and both halves of that are deliberate.**
//
// The application is started ONCE, in `beforeAll`, and each case ADVANCES it. Nothing is rebuilt per
// case, and that is the point rather than an optimisation: the scenario is a SEQUENCE. Fourteen cases that
// each re-ran the prefix would pass in isolation and would no longer be testing anything about order
// — which is exactly the shape of a suite that looks green and means nothing.
//
// The consequence is accepted and worth stating plainly: **the cases depend on execution order and a
// failure CASCADES.** When step 5 fails, steps 6–13 fail too. Nine red does not mean nine bugs — the
// FIRST red names where the narrative broke, and the rest are its consequences. Read top-down and
// stop at the first one.
//
// `describe.sequential` states that requirement rather than inheriting it: Vitest runs cases within a
// file in declaration order today, and a default is a thing that changes.
//
// ---
//
// **The two steps that carry this file**, out of fourteen:
//
//   STEP 8 reads the DOM. It is the only assertion in this repository that checks what a PERSON would
//   see after an agent-driven change to the real application. A scenario reading only tool results
//   would pass with the UI entirely disconnected — this system's characteristic defect. Its break-it
//   is deleting `await context.afterRender()` from the filter handler.
//
//   STEP 13 asserts a REFUSAL, not an absence. An agent may hold a listing from before a withdrawal,
//   and a well-behaved client is not the case a control exists for.
//
// ---
//
// **Three things here are not exactly what a browser runs.** Recorded rather than absorbed, because
// a divergence a reader has to discover is one they will discover by trusting it.
//
//   1. **The screens are mounted on a component router with in-memory history**, not the browser's
//      data router: a data router navigates through `fetch`, and Node's `fetch` refuses jsdom's
//      `AbortSignal`. Routes, pages, components and tools are identical. See `harness.tsx`.
//
//   2. **`shell.go_to` therefore drives a DIFFERENT router than the one rendering here**, and this
//      suite never calls it. `shell-tools.ts` binds the module-scope browser router — correct in a
//      browser, and in this environment a second, unrendered router. A call would report `/activity`
//      while the screen stayed on Customers. So what steps 12 and 13a prove is that a tool leaves
//      with the component that declared it and a shell-owned tool does not — which is the lifecycle
//      claim, and is the whole of what they prove. **The navigation adapter and the data router are
//      verified only by the live run**, which drove both against a real browser and a real socket.
//      Do not add a case that calls `shell.go_to` here expecting the screen to follow.
//
//   3. **The harness composes the provider tree itself rather than mounting `App`**, because `App`
//      reads its connection URL and capability profile from the environment and this suite must
//      supply a gateway of its own. The consequence is honest rather than hidden: a regression in
//      `App`'s OWN wiring — its provider nesting, its validator, its capability selection — would not
//      turn this suite red. What is shared is everything below that seam: the store, the routes, the
//      pages, the components and every tool they declare.

interface CallResult {
  isError?: boolean;
  content?: { text?: string }[];
  structuredContent?: Record<string, unknown>;
}

function textOf(result: CallResult): string {
  return result.content?.[0]?.text ?? '';
}

/** The account names the table is currently showing — what a person would read off the screen. */
function renderedAccountNames(): string[] {
  const table = screen.getByTestId('results');
  return within(table)
    .queryAllByText((_, element) => element?.className === 'row-name')
    .map((element) => element.textContent ?? '');
}

/**
 * Makes one agent call.
 *
 * **Deliberately NOT wrapped in `act()`, and the difference is a deadlock.** The dashboard's handlers
 * await `context.afterRender()` — which is the whole point of them, and what makes step 8 meaningful
 * — so a call does not settle until React has committed. `act()` defers the renderer's work until its
 * callback returns, so awaiting the call inside one waits for a commit that cannot happen until the
 * wait is over. Measured twice: awaiting inside `act` hung for the full timeout, and polling inside
 * `act` on real timers hung too, because the deferral is the problem rather than the scheduling.
 *
 * Outside `act`, React 19 commits on its own scheduler while the call is in flight, which is exactly
 * what happens in a browser — an agent's call arrives as a socket message and nothing wraps it.
 */
async function agentCall(name: string, args: Record<string, unknown>): Promise<CallResult> {
  return (await app.client.callTool({ name, arguments: args })) as CallResult;
}

let app: Application;
/** What step 5's call reported, kept so later steps can hold it against the screen. */
let applied: CallResult;
/** What step 9's read returned. Step 10 asserts about THIS result, never a second read. */
let read: CallResult;

beforeAll(async () => {
  // Scenario steps 1–3: a developer wraps the application in `AgentMcpProvider`, the browser connects to
  // an agent runtime, and `CustomersPage` mounts. A failure here fails everything after it, correctly
  // — there is no scenario without a running application.
  app = await startApplication();
  await act(async () => {
    await until(
      async () => (await listedNames(app.client)).length > 0,
      'step 1-3: the application to connect and register its tools',
    );
  });
}, 30_000);

afterAll(stopApplication);

describe.sequential('the acceptance scenario', () => {
  it('steps 1-3: the application is wrapped, connected, and CustomersPage is mounted', () => {
    // Asserted rather than assumed: `beforeAll` could have resolved with a page that rendered nothing.
    expect(screen.getByTestId('results')).toBeDefined();
    expect(renderedAccountNames().length).toBeGreaterThan(0);
  });

  it('step 4: customers.set_filters becomes visible to the MCP client', async () => {
    expect(await listedNames(app.client)).toContain('customers.set_filters');
  });

  it('step 5: the agent calls customers.set_filters', async () => {
    // **The scenario spells this call `customers.set_filters({ status: ['active'] })`, and this
    // suite does not — recorded here rather than quietly substituted.** The demonstrator has no `status`
    // filter and never had one: its accounts carry `health`, one of `healthy | watch | at_risk |
    // churning`. The literal call is not merely different, it is REFUSED — `additionalProperties` is
    // false on this tool's schema, so `{ status: [...] }` returns MCP_TOOL_ARGUMENTS_INVALID.
    //
    // What is asserted instead: the same SHAPE of call — a closed-vocabulary list filter that
    // narrows the table — under the name the demonstrator actually has. Every property the scenario
    // turns on (the store changes, the screen follows, the agent reads it back, the tool leaves with its
    // screen) is independent of which field was filtered. Changing the demonstrator to have a
    // `status` field instead would be fitting the application to the scenario's prose, which is the
    // one move this feature is not allowed to make.
    applied = await agentCall('customers.set_filters', { health: ['at_risk'] });

    expect(applied.isError).not.toBe(true);
  });

  it('step 6: the application real state changed', () => {
    // Observed through what RENDERED rather than by reading the store. A store the render did not
    // follow is the defect step 8 exists for, and reading the store directly here would hide it.
    expect(renderedAccountNames().length).toBeLessThan(48);

    // **And what the TOOL reported agrees with the screen. THIS is the assertion that catches a
    // deleted `afterRender()`, measured rather than assumed** — see the note on step 8, which is the
    // case the plan expected to catch it and does not.
    //
    // The dashboard's handler reads its result AFTER `await context.afterRender()`, so without that
    // await it reports the PREVIOUS render's totals while the DOM goes on to show the new ones. The
    // agent is told 48 while a person reads 7.
    //
    // The two expectations in this case are load-bearing TOGETHER and neither is redundant. The
    // count comparison alone would pass if the DOM never updated at all and the report were equally
    // stale — both 48, in agreement, and both wrong. The `toBeLessThan` above is what excludes that,
    // and it is why a fixture change that took the account count below 48 would weaken this case:
    // if that happens, the number to compare against is `dashboard`'s own total, not a literal.
    const reported = applied.structuredContent as { matched: number } | undefined;
    const text = (applied.content ?? []).map((block) => block.text ?? '').join('');
    const matched = reported?.matched ?? (JSON.parse(text) as { matched: number }).matched;
    expect(matched).toBe(renderedAccountNames().length);
  });

  it('step 7: React rerendered', () => {
    // The summary bar is a different component from the table and reads the same derived state. If
    // one followed the change and the other did not, the render is partial rather than complete.
    expect(screen.getByTestId('matched').textContent).toBe(String(renderedAccountNames().length));
  });

  it('step 8: the UI displays only the matching customers', () => {
    // **The assertion that makes this a product test.** It reads the DOM after an agent-driven change
    // to the real application: a scenario checking only tool results would pass with the UI entirely
    // disconnected, which is this system's characteristic defect.
    //
    // **What it does NOT catch, corrected here because the plan said otherwise and the measurement
    // said this.** research R5 predicted that deleting `await context.afterRender()` from the filter
    // handler would turn this case red. It does not — with that await removed, all thirteen cases
    // stayed green. A real socket HIDES the race: the agent's round trip gives React far more time
    // than it needs to commit, so by the time this case runs the DOM is already correct.
    //
    // A DOM assertion can see *"the UI never updated"*. It cannot see *"the UI updated LATE"* — and
    // late is the actual defect, because the handler reads its own result before the commit. **Step
    // 6 is what catches it**, by holding the reported count against the rendered rows. Do not delete
    // that comparison believing this case still covers it.
    const names = renderedAccountNames();
    expect(names.length).toBeGreaterThan(0);
    const health = screen.getByTestId('results').querySelectorAll('.pill-at_risk');
    expect(health.length).toBe(names.length);
  });

  it('step 9: the agent calls customers.get_state', async () => {
    // Kept for step 10, which asserts about THIS call's result. Step 10 of the scenario is "the
    // returned state contains the filter" — the state returned by the read in step 9, not by a second read taken
    // afterwards. Two calls would let a stale first read followed by a correct second read pass, and
    // staleness is exactly the failure a read-back exists to expose.
    read = await agentCall('customers.get_state', {});

    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toBeDefined();
  });

  it('step 10: the returned state contains the filter that was applied', async () => {
    const state = read.structuredContent as {
      filters: { active: string[]; values: { health?: string[] } };
      matched: number;
    };

    // The field, and **the VALUE it was set to**. The field name alone says only that some health
    // filter is on, which cannot confirm the agent's own call landed — an agent that asked for
    // `at_risk` and silently got `churning` would read back an identical `active: ['health']`.
    expect(state.filters.active).toContain('health');
    expect(state.filters.values.health).toEqual(['at_risk']);
    // And what the agent was told agrees with what is on screen — the two must never diverge.
    expect(state.matched).toBe(renderedAccountNames().length);
  });

  it('step 11: the user navigates away from CustomersPage', async () => {
    // **A USER navigates, which is what the scenario says** — by clicking a link, not by calling a router
    // method. The agent is not involved in this step and should not be.
    const link = screen.getByRole('link', { name: /activity log/i });
    await act(async () => {
      link.click();
    });

    expect(screen.queryByTestId('results')).toBeNull();
  });

  it('step 12: customers.set_filters is removed from MCP discovery', async () => {
    await act(async () => {
      await until(
        async () => !(await listedNames(app.client)).includes('customers.set_filters'),
        'step 12: the withdrawn tool to leave the agent listing',
      );
    });

    expect(await listedNames(app.client)).not.toContain('customers.set_filters');
  });

  it('step 13: a subsequent invocation of that tool is REJECTED', async () => {
    // Not "is absent" — rejected. The agent still holds a listing from before the navigation, which
    // is precisely the case a control exists for.
    const refused = await agentCall('customers.set_filters', { health: ['healthy'] });

    expect(refused.isError).toBe(true);
    // Matched against the exported dictionary, never a string literal: the error codes are a closed
    // set declared once, and every check derives from that one declaration.
    expect(textOf(refused)).toContain(RUNTIME_FAILURE.toolNotFound);
  });

  it('step 13a: the shell-owned tool SURVIVED the navigation', async () => {
    // Not one of the scenario's numbered steps, and it belongs here anyway: it is the control that makes step
    // 12 meaningful. If every tool vanished on navigation, step 12 would pass for the wrong reason.
    // `shell.go_to` is declared by the application shell rather than by a screen, so it is still
    // there — which is the ownership claim behind tools declared outside React
    // (docs/tools-outside-react.md), asserted from the agent's side.
    expect(await listedNames(app.client)).toContain('shell.go_to');
  });

  it('step 13b: the refused call did not run the withdrawn handler', async () => {
    // **A refusal is a message; this is the effect.** Step 13 proves the agent was told no. It does
    // NOT prove the handler stayed unrun — and the two come apart in a way that looks entirely
    // normal, because `DashboardProvider` sits ABOVE the router and survives the navigation. A
    // regression that invoked the stale closure and then returned `toolNotFound` would mutate the
    // application and still satisfy step 13. Registration is the only exposure, and validation and
    // authorization run in the runtime before the handler — so a removed tool does not execute, and
    // that is what is checked.
    //
    // Step 13 asked for `health: ['healthy']`. The customers screen is remounted here — by a user
    // clicking back, which also re-registers the tools that left with it — and the filter is still
    // the `at_risk` step 5 applied.
    const back = screen.getByRole('link', { name: /back to customers/i });
    await act(async () => {
      back.click();
    });

    const state = (await agentCall('customers.get_state', {})).structuredContent as {
      filters: { values: { health?: string[] } };
    };
    expect(state.filters.values.health).toEqual(['at_risk']);
    expect(renderedAccountNames().length).toBe(7);
  });

  it('step 14: no React internals and no DOM simulation were required', async () => {
    // A claim about HOW the other thirteen steps were achieved, so it is asserted over this file's own
    // source rather than by observing behaviour.
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const here = import.meta.dirname;
    const source = await readFile(join(here, 'acceptance.spec.tsx'), 'utf8');
    const harness = await readFile(join(here, 'harness.tsx'), 'utf8');

    // **Assembled, never written literally**, because this file is one of the two it scans: spelled
    // out, the list would match itself and the case would fail while proving nothing. Found by
    // running it.
    for (const forbidden of [
      `__react${'Fiber'}`,
      `__react${'InternalInstance'}`,
      `__REACT_${'DEVTOOLS'}_GLOBAL_HOOK__`,
      `React${'CurrentDispatcher'}`,
    ]) {
      expect(source, `the scenario must not reach ${forbidden}`).not.toContain(forbidden);
      expect(harness, `the harness must not reach ${forbidden}`).not.toContain(forbidden);
    }

    // No synthetic event stands in for an AGENT call: every agent action above goes through
    // `client.callTool`. The DOM interactions in this file are a person clicking a link — steps 11
    // and 13b — which is what the scenario asks for. Simulating an agent that way would be the "DOM
    // simulation" step 14 forbids; simulating a user is the user.
    //
    // **The event-simulation helpers are refused too**, because counting the direct click calls alone
    // is a check on ONE spelling: the three helpers below would each have passed it while doing
    // precisely the thing being forbidden. Assembled rather than written, for the same reason as the list above —
    // this case scans its own source, and spelling them out fails the case while proving nothing.
    //
    // Honest about what it is: a LEXICAL assertion over two files. It cannot stop a helper imported
    // from a third one. What it does is make the forbidden thing impossible to write ACCIDENTALLY,
    // which is the real failure mode for a claim about how the other thirteen steps were achieved.
    for (const simulator of [`fire${'Event'}`, `user${'Event'}`, `dispatch${'Event'}`]) {
      expect(source, `the scenario must not synthesize events with ${simulator}`).not.toContain(
        simulator,
      );
      expect(harness, `the harness must not synthesize events with ${simulator}`).not.toContain(
        simulator,
      );
    }

    // Two real link clicks, both by a person. The count is written this way because the case scans
    // its own source: a comment mentioning the call literally would be counted as another one, which
    // is exactly what happened first time.
    expect(source.match(/\.click\(\)/g) ?? []).toHaveLength(2);
    expect(source).toContain('client.callTool');
  });
});
