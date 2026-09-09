// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useMcpTool } from '../../../src/react/index.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

// The product claim, in its smallest form: a component declares a tool, an agent lists it, calls it,
// and the application changes.
//
// Every assertion here goes through the MCP client. Reading the library's own ownership record would
// be a test of the record, and the failure this suite exists to catch is a listing that disagrees with
// what the application actually exposed.
//
// It is also the case that holds the effect-ordering finding: `useMcpTool` runs its effect BEFORE the
// provider's, so a hook that resolved the registry itself, or assumed one existed, would find nothing
// here. Delete the registration gateway and this case stops being able to register at all.

afterEach(closeAll);

/** One piece of application state, one visible rendering of it, and one tool that changes it. */
function Panel(): React.ReactNode {
  const [greeting, setGreeting] = useState('unset');

  useMcpTool({
    name: 'panel.set_greeting',
    description: 'Change the greeting the panel displays.',
    inputSchema: {
      type: 'object',
      properties: { greeting: { type: 'string' } },
      required: ['greeting'],
    },
    handler: (input) => {
      const next = String(input.greeting);
      setGreeting(next);
      return { greeting: next };
    },
  });

  return <p data-testid="greeting">{greeting}</p>;
}

describe('a tool a component declared', () => {
  it('is listed by an agent, with what the component declared', async () => {
    const page = await stack(<Panel />);

    await until(
      async () => (await listedNames(page.client)).includes('panel.set_greeting'),
      'the declared tool to appear in what the agent lists',
    );

    const [tool] = (await page.client.listTools()).tools;
    expect(tool?.description).toBe('Change the greeting the panel displays.');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { greeting: { type: 'string' } },
    });
  });

  it('runs when the agent calls it, and the rendered application changes', async () => {
    const page = await stack(<Panel />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.set_greeting'),
      'the declared tool to appear in what the agent lists',
    );

    const result = await page.client.callTool({
      name: 'panel.set_greeting',
      arguments: { greeting: 'hello from the agent' },
    });

    // Both halves are required. A handler that reported success while the DOM never changed is this
    // system's characteristic defect, and the return value alone cannot tell the two apart.
    expect(result.isError ?? false).toBe(false);
    await until(
      () => page.rendered.getByTestId('greeting').textContent === 'hello from the agent',
      'the rendered panel to show what the agent set',
    );
  });

  it('raises no unexpected-state alarm along the way', async () => {
    const page = await stack(<Panel />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.set_greeting'),
      'the declared tool to appear in what the agent lists',
    );
    await page.client.callTool({
      name: 'panel.set_greeting',
      arguments: { greeting: 'anything' },
    });

    // An ownership divergence here would mean the library wrote a record entry for something the
    // registry does not have — the divergence alarm, fired by this path's own bookkeeping.
    expect(page.unexpected).toEqual([]);
  });
});
