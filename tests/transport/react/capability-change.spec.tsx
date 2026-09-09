// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useMcpTool } from '../../../src/react/index.ts';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { APPLICATION_ONLY, NOTHING_GRANTED } from '../../support/capabilities.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

/** The code carried by a failure, without asserting anything about its class. */
function codeOf(failure: unknown): string | undefined {
  const code = (failure as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

// An application changing what its agent may reach, while the agent is connected.
//
// This is the provider half of the live read. The runtime's own suite proves the gate consults a
// supplier; this proves the supplier the provider hands over is wired to the PROP, so that changing
// the prop actually changes what an agent can do.
//
// **What must not happen is as much of the claim as what must.** A capability change is a prop change
// on a component that owns a socket, a document claim and a registry full of tools. If the set had
// landed in the mount effect's dependency list — the obvious way to write this — granting a capability
// would tear down the connection, release the claim, withdraw every tool and dial again, and the
// symptom would be an agent watching the page it is driving disappear and come back. So the states the
// provider reported and the tools it has registered are asserted alongside the behaviour.

afterEach(closeAll);

function Panel(): ReactNode {
  useMcpTool({
    name: 'panel.bump',
    description: 'Increment the panel counter.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ bumped: true }),
  });
  return null;
}

interface CallResult {
  isError?: boolean;
  content?: { text?: string }[];
}

function textOf(result: CallResult): string {
  return result.content?.[0]?.text ?? '';
}

/**
 * Lets any asynchronous work a prop change started run to completion.
 *
 * For assertions about an ABSENCE, where there is no condition to wait for — nothing reconnected,
 * nothing re-registered. It yields turns rather than timing anything: a teardown and redial are
 * asynchronous, so comparing immediately after the rerender would find the states unchanged whether or
 * not the connection was about to be torn down. That version of this case passed against a provider
 * that DID reconnect, which is how it came to be written this way.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

describe('a provider whose capability prop changes', () => {
  it('changes what the next call is allowed to do, with no remount anywhere', async () => {
    const page = await stack(<Panel />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.bump'),
      'the tool to be listed',
    );

    const granted = (await page.client.callTool({
      name: 'panel.bump',
      arguments: {},
    })) as CallResult;
    expect(granted.isError).toBeUndefined();

    page.grant(NOTHING_GRANTED);

    const refused = (await page.client.callTool({
      name: 'panel.bump',
      arguments: {},
    })) as CallResult;
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(RUNTIME_FAILURE.capabilityDenied);
  });

  it('costs no reconnection', async () => {
    // **Asserted on a MONOTONIC counter, and the first version of this case was not.** It compared the
    // reported connection states before and after; a teardown and redial are asynchronous, so the
    // comparison ran first and the case passed against a provider that did reconnect. Widening the
    // wait would have been the mistake of masking a defect instead of fixing it — the fix is a
    // quantity that cannot go back
    // down. One dial happened at mount; a reconnection would be a second.
    const page = await stack(<Panel />);
    await until(() => page.states.includes('connected'), 'the provider to report connected');

    const dialsBefore = page.dials();
    page.grant(NOTHING_GRANTED);
    page.grant(APPLICATION_ONLY);
    await settle();

    expect(page.dials()).toBe(dialsBefore);
    expect(page.states.at(-1)).toBe('connected');
  });

  it('costs no registration cycle, and the tool the agent sees is untouched', async () => {
    // **Also a monotonic counter, for the same reason and a second one.** A registration COUNT is
    // unchanged by a full withdraw-and-register cycle — one before, one after — so counting
    // registrations cannot see the defect at all. The registry's change EVENT can: it is what an agent
    // observes as a `tools/list_changed` storm, and in the window between the two halves the tool does
    // not exist for a page script either.
    const page = await stack(<Panel />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.bump'),
      'the tool to be listed',
    );

    const changesBefore = page.registryChanges();
    page.grant(NOTHING_GRANTED);
    await settle();

    expect(page.registryChanges()).toBe(changesBefore);
    expect(await listedNames(page.client)).toContain('panel.bump');
    expect(page.unexpected).toEqual([]);
  });

  it('is granted back on the same connection', async () => {
    // The pairing. Without it, a provider that refused everything after the first prop change would
    // pass every case above.
    const page = await stack(<Panel />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.bump'),
      'the tool to be listed',
    );

    page.grant(NOTHING_GRANTED);
    expect(
      ((await page.client.callTool({ name: 'panel.bump', arguments: {} })) as CallResult).isError,
    ).toBe(true);

    page.grant(APPLICATION_ONLY);
    const again = (await page.client.callTool({
      name: 'panel.bump',
      arguments: {},
    })) as CallResult;
    expect(again.isError).toBeUndefined();
  });

  it('keeps serving when the set becomes unreadable, and admits again when it is corrected', async () => {
    // **Found by an adversarial review, which showed the version of this in `tests/react/` was a false
    // green: it read the DOCUMENT REGISTRY, where the tool never went away, instead of the agent's
    // view, where it did.**
    //
    // The defect: a running provider handed an unreadable set tore the bridge down — runtime shut,
    // gateway closed, claim released, socket dropped with nothing to reconnect it. The registrations
    // stayed in the document, correctly, and the next usable render built a runtime with an empty
    // ownership record that classified them all as another script's. The page's whole tool set was
    // gone from the agent for good.
    //
    // What must happen instead: every bridged call is refused while the set cannot be read, the
    // operator is told, and a corrected set admits again — on the same connection, with nothing rebuilt.
    const page = await stack(<Panel />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.bump'),
      'the tool to be listed',
    );

    const dialsBefore = page.dials();
    // An author's typo, arriving through a cast exactly as it would from JavaScript or from JSON.
    page.grant({
      application: true,
      dom: { inspect: false, interact: false },
      evalaute: true,
    } as never);
    await settle();

    // The operator hears about it.
    expect(
      page.unexpected.some((failure) => codeOf(failure) === RUNTIME_FAILURE.capabilitiesUnusable),
    ).toBe(true);
    // Every call is refused...
    const refused = (await page.client.callTool({
      name: 'panel.bump',
      arguments: {},
    })) as CallResult;
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(RUNTIME_FAILURE.capabilityDenied);
    // ...and the bridge is still there to refuse them, on the connection it already had.
    expect(page.dials()).toBe(dialsBefore);

    page.grant(APPLICATION_ONLY);
    await settle();

    const admitted = (await page.client.callTool({
      name: 'panel.bump',
      arguments: {},
    })) as CallResult;
    expect(admitted.isError).toBeUndefined();
    expect(page.dials()).toBe(dialsBefore);
  });

  it('is unmoved by a rerender that grants exactly what was already granted', async () => {
    // `capabilities={{ ... }}` is a new object on every render. What the provider reacts to is the
    // granted SET, not the identity of the object carrying it — otherwise every rerender of the
    // application would tell the agent its capabilities had changed, which is a notification storm
    // built out of nothing happening.
    const page = await stack(<Panel />);
    await until(() => page.states.includes('connected'), 'the provider to report connected');

    const before = [...page.states];
    for (let render = 0; render < 5; render += 1) {
      page.grant({ application: true, dom: { inspect: false, interact: false }, evaluate: false });
    }
    await settle();

    expect([...page.states]).toEqual(before);
    expect(
      ((await page.client.callTool({ name: 'panel.bump', arguments: {} })) as CallResult).isError,
    ).toBeUndefined();
  });
});
