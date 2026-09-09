// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerMcpTool } from '../../../src/actions/index.ts';
import { resetDeclarationsForTests } from '../../../src/actions/queue.ts';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

// A tool nothing rendered, driven by a real MCP client over a real socket.
//
// The design is careful about what "static" means — *"'Static' describes OWNERSHIP, never an exemption
// from the lifecycle"* (docs/tools-outside-react.md#static-describes-ownership-not-an-exemption) — and
// this file is where that stops being a sentence. A shell-owned tool is listed,
// called, updated and withdrawn exactly as a component's is, and the only difference is who owns it.
//
// Asserted from the far end of the socket rather than against the registry, because "it is in the
// registry" and "an agent can use it" are different claims and only the second one matters.

interface CallResult {
  isError?: boolean;
  content?: { text?: string }[];
}

function textOf(result: CallResult): string {
  return result.content?.[0]?.text ?? '';
}

beforeEach(resetDeclarationsForTests);

afterEach(async () => {
  await closeAll();
  resetDeclarationsForTests();
});

describe('a tool owned by the application shell', () => {
  it('is listed and callable although no component declared it', async () => {
    let loggedOut = 0;
    registerMcpTool({
      name: 'session.logout',
      description: 'Logs out the current user.',
      handler: () => {
        loggedOut += 1;
        return { loggedOut: true };
      },
    });

    // NOTE the children: nothing. The whole tree is empty, so anything the agent sees was declared
    // outside React entirely.
    const under = await stack(null);
    await act(async () => {
      await until(
        async () => (await listedNames(under.client)).includes('session.logout'),
        'waited for the shell-owned tool to be listed',
      );
    });

    const result = (await under.client.callTool({
      name: 'session.logout',
      arguments: {},
    })) as CallResult;

    expect(result.isError).not.toBe(true);
    expect(loggedOut).toBe(1);
  });

  it('changes its description with exactly one notification, and none when unchanged', async () => {
    const handle = registerMcpTool({
      name: 'session.logout',
      description: 'Logs out the current user.',
      handler: () => ({ loggedOut: true }),
    });
    const under = await stack(null);
    await act(async () => {
      await until(
        async () => (await listedNames(under.client)).includes('session.logout'),
        'waited for listing',
      );
    });

    const baseline = under.notifications();

    // The handle's contract says this explicitly: calling update() with an unchanged descriptor does
    // nothing (docs/tools-outside-react.md#the-handle).
    // Without it an application calling update() from a store subscription produces a storm, and the
    // tool stays correct throughout — which is how it goes unnoticed.
    for (let turn = 0; turn < 20; turn += 1) {
      handle.update({ description: 'Logs out the current user.' });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(under.notifications()).toBe(baseline);

    handle.update({ description: 'Ends the current session.' });
    await act(async () => {
      await until(
        async () => under.notifications() > baseline,
        'waited for the change to reach the agent',
      );
    });

    const listed = await under.client.listTools();
    expect(listed.tools.find((tool) => tool.name === 'session.logout')?.description).toBe(
      'Ends the current session.',
    );
  });

  it('is REFUSED after remove(), not merely absent from the listing', async () => {
    const handle = registerMcpTool({
      name: 'session.logout',
      description: 'Logs out the current user.',
      handler: () => ({ loggedOut: true }),
    });
    const under = await stack(null);
    await act(async () => {
      await until(
        async () => (await listedNames(under.client)).includes('session.logout'),
        'waited for listing',
      );
    });

    handle.remove();
    await act(async () => {
      await until(
        async () => !(await listedNames(under.client)).includes('session.logout'),
        'waited for withdrawal',
      );
    });

    const refused = (await under.client.callTool({
      name: 'session.logout',
      arguments: {},
    })) as CallResult;

    // Absence from a listing is not an access control: an agent may hold a list from before the
    // withdrawal, and a well-behaved client is not the case a control exists for.
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(RUNTIME_FAILURE.toolNotFound);
  });
});
