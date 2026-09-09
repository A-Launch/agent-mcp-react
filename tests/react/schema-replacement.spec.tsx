import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTool } from '../../src/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  boundary,
  clearRegistry,
  enterSecureContext,
  neverConnects,
  recorder,
  testValidator,
  until,
} from './harness.ts';

// What happens when a descriptor change carries a schema that cannot be compiled.
//
// **The trap this file exists for, stated plainly.** The handler ref is updated in a LAYOUT effect,
// on every commit, unconditionally — that is what makes a rerender cost nothing. Registration work
// happens later, in a passive effect, and asynchronously. So by the time a replacement discovers that
// the new schema will not compile, the handler is ALREADY the new one.
//
// Leaving the old registration standing therefore does not "keep the tool working as it was". It
// leaves the OLD schema gating the NEW handler: arguments checked against a contract the code behind
// them no longer has. That is a silently wrong call, which is the failure class this whole library is
// built around — so the tool is withdrawn instead.

beforeEach(() => {
  enterSecureContext();
  clearRegistry();
});
afterEach(clearRegistry);

async function registeredNames(): Promise<string[]> {
  const registry = (
    document as unknown as { modelContext?: { getTools?: () => Promise<{ name: string }[]> } }
  ).modelContext;
  return ((await registry?.getTools?.()) ?? []).map((tool) => tool.name);
}

const GOOD = { type: 'object', properties: { level: { type: 'string' } } };
// `requird` is not a keyword the dialect defines. With unknown keywords refused — which is how this
// library configures the validator — compiling this throws.
const UNCOMPILABLE = {
  type: 'object',
  properties: { level: { type: 'string' } },
  requird: ['level'],
};

describe('a descriptor change whose new schema will not compile', () => {
  it('withdraws the tool rather than leaving the old schema over the new handler', async () => {
    let breakIt: ((on: boolean) => void) | undefined;
    const caught = recorder();

    function Screen(): React.ReactNode {
      const [broken, setBroken] = useState(false);
      breakIt = setBroken;
      useMcpTool({
        name: 'panel.set',
        description: 'sets the panel',
        inputSchema: broken ? UNCOMPILABLE : GOOD,
        handler: () => (broken ? 'new behaviour' : 'old behaviour'),
      });
      return null;
    }

    // A refused registration is the author's to see, and it is REPORTED rather than thrown: it used to
    // re-throw from the provider's render, which unmounted the application over a schema an author
    // could fix in a second. The boundary stays wired so this case would notice if that came back.
    render(
      boundary(
        caught,
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: neverConnects }}
          server={{ name: 'p', version: '0' }}
          validation={{ validator: testValidator }}
          onUnexpectedState={() => undefined}
          onRegistration={(event) => caught.refused.push(event)}
        >
          <Screen />
        </AgentMcpProvider>,
      ),
    );
    await act(async () => {
      await until(
        async () => (await registeredNames()).includes('panel.set'),
        'first registration',
      );
    });

    await act(async () => {
      breakIt?.(true);
    });
    await act(async () => {
      for (let turn = 0; turn < 20; turn += 1) await new Promise((r) => setImmediate(r));
    });

    // **Absent, not present-with-a-stale-contract.** A tool left registered here would validate
    // against `GOOD` and execute the handler that returns "new behaviour" — the exact mismatch a
    // declared schema exists to make impossible.
    expect(await registeredNames()).not.toContain('panel.set');

    // And the author is told why, loudly. A tool that vanished silently would be worse than one left
    // wrong: nothing on the page would indicate that a schema stopped compiling.
    // Reported somewhere is the claim; which channel is the library's business and is asserted by the
    // cases that own it. The boundary must stay empty — a report is not a teardown.
    expect(caught.refused.length + caught.unexpected.length).toBeGreaterThan(0);
    expect(caught.caught).toEqual([]);
  });

  it('leaves a tool alone when the change compiles', async () => {
    let widen: ((on: boolean) => void) | undefined;

    function Screen(): React.ReactNode {
      const [wide, setWide] = useState(false);
      widen = setWide;
      useMcpTool({
        name: 'panel.set',
        description: 'sets the panel',
        inputSchema: wide
          ? { type: 'object', properties: { level: { type: 'string' }, extra: { type: 'number' } } }
          : GOOD,
        handler: () => 'ok',
      });
      return null;
    }

    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'p', version: '0' }}
        validation={{ validator: testValidator }}
        onUnexpectedState={() => undefined}
      >
        <Screen />
      </AgentMcpProvider>,
    );
    await act(async () => {
      await until(async () => (await registeredNames()).includes('panel.set'), 'registration');
    });

    await act(async () => {
      widen?.(true);
    });
    await act(async () => {
      for (let turn = 0; turn < 20; turn += 1) await new Promise((r) => setImmediate(r));
    });

    // The pairing. Without it, a replacement path that withdrew on EVERY change would pass the case
    // above while destroying the feature.
    expect(await registeredNames()).toContain('panel.set');
  });
});
