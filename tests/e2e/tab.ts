// Which tab belongs to the page under test, asked of the page rather than inferred from the agent.
//
// **The one owner of that answer for the whole end-to-end layer.** Two specs used to answer it two
// different ways and both were wrong in the same way: they read the agent's GLOBAL tab list and
// reasoned about it. `composable-board.spec.ts` required exactly one READY tab; `csp-evaluate.spec.ts`
// took the difference between two reads of that list. Neither can be correct, because the list is not
// scoped to the test that reads it — `playwright.config.ts` sets `fullyParallel`, six spec files open
// a page, and three engine projects run at once, all pointed at one mock agent on one port. Serial
// mode inside a file cannot see a neighbouring file or a neighbouring engine, so both spellings
// addressed whichever page happened to be connected. The symptom was an intermittent
// `MCP_TOOL_NOT_FOUND` for a tool the OTHER demonstrator does not have.
//
// The page already knows the answer with no ambiguity at all: the library mints one identity per page
// instance and the demonstrators publish it as `data-tab-id` on their connection indicator. Reading it
// from the page removes the question rather than answering it more carefully — there is no global
// state left to race on, and a case that deliberately connects a second page no longer needs the
// global count to be any particular number.
//
// What is still genuinely asynchronous is the agent's view: the socket opens, and the tab stays
// `connecting` there until MCP `initialize` completes. That is a handshake crossing a real socket, so
// it is polled — a wait on a boundary, never a delay standing in for synchronization.

import { expect, type Page } from '@playwright/test';

const AGENT = process.env.AMR_AGENT_HTTP ?? 'http://localhost:45000';

/** Every tab the agent currently holds, whatever its state. */
export async function connectedTabs(): Promise<{ tabId: string | null; state: string }[]> {
  const body = (await (await fetch(`${AGENT}/agent`)).json()) as {
    tabs: { tabId: string | null; state: string }[];
  };
  return body.tabs;
}

/**
 * The identity this page minted for itself, read from the page's own DOM.
 *
 * Waits for the attribute to carry a value: the provider mints the id during its first effect, so a
 * page that has rendered its connection indicator has not necessarily published one yet.
 */
export async function tabIdOf(page: Page): Promise<string> {
  const indicator = page.getByTestId('connection');
  await expect
    .poll(async () => (await indicator.getAttribute('data-tab-id')) ?? '', { timeout: 15_000 })
    .not.toBe('');
  return (await indicator.getAttribute('data-tab-id')) ?? '';
}

/**
 * This page's tab, once the AGENT reports it ready to answer.
 *
 * Asserts nothing about any other tab, which is the entire point: another spec file's page, or the
 * same page under another engine, may be connected throughout and changes nothing here.
 */
export async function readyTabOf(page: Page): Promise<string> {
  const mine = await tabIdOf(page);
  await expect
    .poll(
      async () =>
        (await connectedTabs()).some((tab) => tab.tabId === mine && tab.state === 'ready'),
      { timeout: 20_000 },
    )
    .toBe(true);
  return mine;
}
