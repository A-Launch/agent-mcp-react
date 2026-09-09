// @vitest-environment jsdom
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useMcpTool } from '../../../src/react/index.ts';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

// An application opening and closing one of its own tools while an agent is connected.
//
// **The claim that costs something, and the reason `refresh` exists at all:** an availability change
// must not touch the document's registry. `available` tracks application state — a tool offered only
// while a form is valid changes on every keystroke — and routed through the descriptor comparison it
// would cost a full withdraw-and-register cycle each time. That is a `tools/list_changed` storm for
// the agent, an alarm from the churn detector for the operator, and a window per cycle in which the
// tool does not exist for a page script either.
//
// So every case here that asserts a change reaches the agent is paired with one asserting the registry
// never moved, on a MONOTONIC counter: a registration count is unchanged by a withdraw-and-register
// cycle — one before, one after — and cannot see the defect at all.

afterEach(closeAll);

/**
 * Yields turns for asynchronous work to finish.
 *
 * **A budget, and it is not what any absence here is proved by.** An adversarial review was right that
 * "nothing happened in forty turns" is a timing tolerance that masks a defect rather than fixing it —
 * a wrong registry
 * cycle landing on turn forty-one would pass. So every absence in this file is asserted on a MONOTONIC
 * counter and paired with a positive that only becomes true once the work has actually happened: the
 * change reached the agent, and the counter did not move. A late cycle would still be a cycle, and the
 * counter would still have it.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

interface CallResult {
  isError?: boolean;
  content?: { text?: string }[];
}

function textOf(result: CallResult): string {
  return result.content?.[0]?.text ?? '';
}

/** A panel whose tool is offered only while the form it belongs to is complete. */
function Invoice({ open }: { open: boolean }): ReactNode {
  useMcpTool({
    name: 'invoice.mark_paid',
    description: 'Mark the open invoice as paid.',
    inputSchema: { type: 'object', properties: {} },
    permissions: { available: open },
    handler: () => ({ paid: true }),
  });
  return null;
}

/** The same tool, with availability driven from state the component owns. */
function Typing(): ReactNode {
  const [text, setText] = useState('');
  useMcpTool({
    name: 'form.submit',
    description: 'Submit the form.',
    inputSchema: { type: 'object', properties: {} },
    permissions: { available: text.length > 3 },
    handler: () => ({ submitted: true }),
  });
  useMcpTool({
    name: 'form.type',
    description: 'Type into the form.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    handler: (args) => {
      setText(String(args.text ?? ''));
      return { typed: true };
    },
  });
  return null;
}

describe('a tool the application closes while the agent is connected', () => {
  it('stops being listed, and stops being callable', async () => {
    const page = await stack(<Invoice open />);
    await until(
      async () => (await listedNames(page.client)).includes('invoice.mark_paid'),
      'the tool to be listed while it is offered',
    );

    const whileOpen = (await page.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;
    expect(whileOpen.isError).toBeUndefined();

    page.setChildren(<Invoice open={false} />);
    await settle();

    expect(await listedNames(page.client)).not.toContain('invoice.mark_paid');
    const whileClosed = (await page.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;
    expect(textOf(whileClosed)).toContain(RUNTIME_FAILURE.toolUnavailable);
  });

  it('costs no registry cycle', async () => {
    // **The claim `refresh` exists for.** Asserted on the registry's change events, which are
    // monotonic and are what an agent would experience as a storm — never on a registration count,
    // which a full withdraw-and-register cycle leaves at exactly one.
    const page = await stack(<Invoice open />);
    await until(
      async () => (await listedNames(page.client)).includes('invoice.mark_paid'),
      'the tool to be listed',
    );
    await settle();

    const before = page.registryChanges();
    page.setChildren(<Invoice open={false} />);
    await until(
      async () => !(await listedNames(page.client)).includes('invoice.mark_paid'),
      'the tool to stop being listed',
    );
    page.setChildren(<Invoice open />);
    await until(
      async () => (await listedNames(page.client)).includes('invoice.mark_paid'),
      'the tool to be listed again',
    );

    // **Waited for the WORK, then asserted the counter.** Not "nothing happened for a while": both
    // changes have demonstrably landed by the time this line runs, so a registry cycle they cost would
    // already be counted. The counter is monotonic, so a late one could not have been undone either.
    expect(page.registryChanges()).toBe(before);
    // And the churn detector, which is what an operator would hear if this went through `replace`.
    expect(page.unexpected).toEqual([]);
  });

  it('opens again, on the same connection', async () => {
    // The pairing. A `refresh` that only ever closed a tool would satisfy the two cases above.
    const page = await stack(<Invoice open={false} />);
    await settle();

    expect(await listedNames(page.client)).not.toContain('invoice.mark_paid');

    page.setChildren(<Invoice open />);
    await until(
      async () => (await listedNames(page.client)).includes('invoice.mark_paid'),
      'the tool to be listed once it is offered again',
    );

    const result = (await page.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;
    expect(result.isError).toBeUndefined();
  });

  it('is unavailable from its very first render, not for one turn first', async () => {
    // A tool declared unavailable at mount must never be callable. If the permissions arrived only by
    // a later refresh there would be a turn in which an agent listing at exactly the wrong moment
    // could reach it — which is the window an agent connecting as the page loads sits in.
    const page = await stack(<Invoice open={false} />);

    const result = (await page.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;
    expect(textOf(result)).toContain(RUNTIME_FAILURE.toolUnavailable);
  });
});

describe('what the agent is TOLD, as opposed to what it would find if it asked', () => {
  // **The half a re-listing case cannot establish, and the reason `refresh` announces at all.**
  //
  // Nothing polls — the design forbids it — so a notification is the entire mechanism by which an
  // agent learns that the
  // page changed. A build whose listing is correct and whose notification never fires looks perfect to
  // a test that calls `listTools` again, and is silently stale to every real agent — which then calls
  // a tool the application closed and is refused for reasons its picture of the page cannot explain.
  //
  // Measured while writing this file: writing the permission onto the entry IN PLACE rather than
  // re-adding it leaves every listing case in this file green, because the listing is derived on every
  // request. Only a frame count sees it.

  it('sends one change notification when a tool closes', async () => {
    const page = await stack(<Invoice open />);
    await until(
      async () => (await listedNames(page.client)).includes('invoice.mark_paid'),
      'the tool to be listed',
    );
    await settle();

    const before = page.notifications();
    page.setChildren(<Invoice open={false} />);
    await until(
      () => page.notifications() > before,
      'a tool-list-changed frame to be written to the socket',
    );

    // Exactly one. Waited for at least one above, so this is the "and no more" half — the storm
    // assertion rather than the arrival assertion.
    await settle();
    expect(page.notifications()).toBe(before + 1);
  });

  it('sends one when it opens again', async () => {
    const page = await stack(<Invoice open={false} />);
    await settle();

    const before = page.notifications();
    page.setChildren(<Invoice open />);
    await until(
      () => page.notifications() > before,
      'a tool-list-changed frame to be written to the socket',
    );

    await settle();
    expect(page.notifications()).toBe(before + 1);
  });

  it('sends nothing for a rerender that changes no availability', async () => {
    // The pairing, and it is a claim about the SYSTEM rather than about this path.
    //
    // Measured: comparing `permissions` by identity instead of by content — so that every render
    // queues a refresh — leaves this green. The publisher speaks only when the derived listing
    // actually differs, and it absorbs them. So the frame-level guarantee belongs to the publisher
    // rather than to the hook, and the content comparison there is what stops a gateway task per render
    // rather than what stops a frame per render. Recorded because the obvious reading of a green here
    // is that the comparison is what saved the agent, and it is not.
    const page = await stack(<Invoice open />);
    await until(
      async () => (await listedNames(page.client)).includes('invoice.mark_paid'),
      'the tool to be listed',
    );
    await settle();

    const before = page.notifications();
    for (let render = 0; render < 5; render += 1) page.setChildren(<Invoice open />);
    await settle();
    // Paired with a change that DOES notify, on the same connection and after the quiet renders — so
    // this is not "nothing arrived within a budget" but "the channel was working and stayed quiet".
    page.setChildren(<Invoice open={false} />);
    await until(
      () => page.notifications() > before,
      'the channel to prove it still sends when something actually changes',
    );

    expect(page.notifications()).toBe(before + 1);
  });
});

describe('availability that tracks something an agent can change', () => {
  it('opens the tool as a consequence of the agent using another one', async () => {
    // The shape this feature is for, end to end: the agent types, the application re-renders, and the
    // tool it could not reach a moment ago becomes reachable.
    //
    // **This case re-lists to observe that**, so it establishes the outcome and says nothing about how
    // an agent would learn of it. The claim that the agent is TOLD — which the ban on polling makes
    // load-bearing — is asserted on frame counts above, and an earlier version of this
    // comment claimed it here, where nothing was measuring it.
    const page = await stack(<Typing />);
    await until(
      async () => (await listedNames(page.client)).includes('form.type'),
      'the page to register its tools',
    );

    const tooEarly = (await page.client.callTool({
      name: 'form.submit',
      arguments: {},
    })) as CallResult;
    expect(textOf(tooEarly)).toContain(RUNTIME_FAILURE.toolUnavailable);

    await page.client.callTool({ name: 'form.type', arguments: { text: 'hello' } });
    await until(
      async () => (await listedNames(page.client)).includes('form.submit'),
      'the submit tool to become available once the form has content',
    );

    const now = (await page.client.callTool({
      name: 'form.submit',
      arguments: {},
    })) as CallResult;
    expect(now.isError).toBeUndefined();
  });

  it('costs no registry cycle while it does that either', async () => {
    const page = await stack(<Typing />);
    await until(
      async () => (await listedNames(page.client)).includes('form.type'),
      'the page to register its tools',
    );
    await settle();

    const before = page.registryChanges();
    for (const text of ['h', 'he', 'hel', 'hell', 'hello', 'hi', 'h', '']) {
      await page.client.callTool({ name: 'form.type', arguments: { text } });
    }
    // The last keystroke emptied the field, so the tool is closed again — waited for, so that every
    // one of the eight changes has demonstrably landed before the counter is read.
    await until(
      async () => !(await listedNames(page.client)).includes('form.submit'),
      'the submit tool to close again after the last keystroke',
    );

    // Eight keystrokes, each crossing the availability threshold in one direction or the other.
    // Through the descriptor path this would be eight withdraw-and-register cycles.
    expect(page.registryChanges()).toBe(before);
    expect(page.unexpected).toEqual([]);
  });
});

describe('a descriptor change on a tool that is closed', () => {
  // **Found by an adversarial review: the replacement path's permission carry had no load-bearing
  // test.** The rename case below changes the name AND reopens the tool, so the refresh that follows
  // repairs a replacement that dropped the permissions — deleting either carry left every case green.
  //
  // The interleaving that has no repair: a descriptor changes while the tool stays closed. The
  // permission version does not move, so no refresh follows, and a replacement that dropped
  // `permissions` recreates the entry wide open. The tool the application has closed is then listed
  // and callable, silently, because its description changed.

  it('stays closed when only its description changed', async () => {
    function Describing({ description }: { description: string }): ReactNode {
      useMcpTool({
        name: 'invoice.mark_paid',
        description,
        inputSchema: { type: 'object', properties: {} },
        permissions: { available: false },
        handler: () => ({ paid: true }),
      });
      return null;
    }

    const page = await stack(<Describing description="Mark it paid." />);
    await settle();
    expect(await listedNames(page.client)).not.toContain('invoice.mark_paid');

    page.setChildren(<Describing description="Mark the open invoice as paid." />);
    await settle();

    expect(await listedNames(page.client)).not.toContain('invoice.mark_paid');
    const result = (await page.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;
    expect(textOf(result)).toContain(RUNTIME_FAILURE.toolUnavailable);
  });

  it('stays closed when it is renamed and stays closed', async () => {
    // The rename half of the same gap, with the reopen removed so nothing repairs it.
    function Renaming({ name }: { name: string }): ReactNode {
      useMcpTool({
        name,
        description: 'A tool that moves.',
        inputSchema: { type: 'object', properties: {} },
        permissions: { available: false },
        handler: () => ({ ok: true }),
      });
      return null;
    }

    const page = await stack(<Renaming name="panel.a" />);
    await settle();

    page.setChildren(<Renaming name="panel.b" />);
    await settle();

    expect(await listedNames(page.client)).not.toContain('panel.b');
    const result = (await page.client.callTool({
      name: 'panel.b',
      arguments: {},
    })) as CallResult;
    expect(textOf(result)).toContain(RUNTIME_FAILURE.toolUnavailable);
  });

  it('reopens when the application says so, which is what makes the two above mean anything', async () => {
    function Describing({ description, open }: { description: string; open: boolean }): ReactNode {
      useMcpTool({
        name: 'invoice.mark_paid',
        description,
        inputSchema: { type: 'object', properties: {} },
        permissions: { available: open },
        handler: () => ({ paid: true }),
      });
      return null;
    }

    const page = await stack(<Describing description="Mark it paid." open={false} />);
    await settle();

    page.setChildren(<Describing description="Mark the open invoice as paid." open />);
    await until(
      async () => (await listedNames(page.client)).includes('invoice.mark_paid'),
      'the tool to be listed once it is offered again',
    );
  });
});

describe('a permission change racing the component that declared it', () => {
  it('does not resurrect an entry for a tool that has gone', async () => {
    // A refresh is queued in one turn and runs in a later one; the component can unmount
    // in between. Writing then would put an ownership entry under a name the registry no longer holds
    // — a divergence this library manufactured itself, which the runtime correctly reports as a broken
    // invariant. An operator would be chasing an alarm about a tool nobody touched.
    const page = await stack(<Invoice open />);
    await until(
      async () => (await listedNames(page.client)).includes('invoice.mark_paid'),
      'the tool to be listed',
    );

    // The permission change and the unmount in the same commit.
    page.setChildren(<Invoice open={false} />);
    page.setChildren(null);
    await settle();

    expect(await listedNames(page.client)).not.toContain('invoice.mark_paid');
    // The alarm channel is the assertion. A resurrected entry shows up as an ownership divergence on
    // the very next listing, and nothing else in this scenario would put anything here.
    expect(page.unexpected).toEqual([]);
  });

  it('does not write onto a tool that has since been renamed', async () => {
    // The other half of the same guard, and the one the withdrawal check alone does not cover in an
    // obvious way: after a rename the OLD name is held by nobody, so a late refresh for it would
    // create an entry from nothing.
    function Renaming({ name, open }: { name: string; open: boolean }): ReactNode {
      useMcpTool({
        name,
        description: 'A tool that moves.',
        inputSchema: { type: 'object', properties: {} },
        permissions: { available: open },
        handler: () => ({ ok: true }),
      });
      return null;
    }

    const page = await stack(<Renaming name="panel.a" open />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.a'),
      'the first name to be listed',
    );

    page.setChildren(<Renaming name="panel.a" open={false} />);
    page.setChildren(<Renaming name="panel.b" open />);
    await settle();

    const names = await listedNames(page.client);
    expect(names).toContain('panel.b');
    expect(names).not.toContain('panel.a');
    expect(page.unexpected).toEqual([]);
  });
});
