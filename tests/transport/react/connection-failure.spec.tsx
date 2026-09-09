// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentMcpProvider,
  CONNECTION_STATUS,
  type McpConnectionState,
  useMcpTool,
} from '../../../src/react/index.ts';
import { createAjvValidator } from '../../../src/validation/ajv.ts';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';
import { closeAll, declareSecureContext, until } from './harness.tsx';

// An attempt that cannot connect, and the credential that must not appear anywhere it produces.
//
// A connection URL carries a single-use ticket in its query string, and a failed connection is exactly
// the moment a URL gets printed — into a console, into an error, into a status indicator, and from
// there into an issue. The transport scrubs it; this case holds that nothing on the way back up
// re-introduces it, including a `console.error` that no error-shaped assertion would ever look at.

const TICKET = 'AMR-TICKET-DO-NOT-LEAK-4f2b';
const UNREACHABLE = `ws://127.0.0.1:1/?ticket=${TICKET}&tab=tab-1`;

afterEach(closeAll);

function Tool(): null {
  useMcpTool({ name: 'offline.tool', description: 'declared while offline', handler: () => ({}) });
  return null;
}

/** Captures everything written to the console, and restores it. */
function recordConsole(): { written: string[]; restore(): void } {
  const written: string[] = [];
  const original = { error: console.error, warn: console.warn, log: console.log };
  const capture = (...parts: unknown[]): void => {
    written.push(parts.map((part) => String(part)).join(' '));
  };
  console.error = capture;
  console.warn = capture;
  console.log = capture;
  return {
    written,
    restore() {
      console.error = original.error;
      console.warn = original.warn;
      console.log = original.log;
    },
  };
}

async function mountAgainstDeadPort(): Promise<{
  states: McpConnectionState[];
  view: ReturnType<typeof render>;
}> {
  declareSecureContext();
  const states: McpConnectionState[] = [];
  const view = render(
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: async () => UNREACHABLE }}
      server={{ name: 'offline-page', version: '0.0.0' }}
      validation={{ validator: sharedValidator }}
      onUnexpectedState={() => undefined}
      onConnectionChange={(state) => states.push(state)}
    >
      <Tool />
    </AgentMcpProvider>,
  );
  await until(
    () => states.at(-1)?.status === CONNECTION_STATUS.error,
    'the provider to report the attempt failed',
  );
  return { states, view };
}

const sharedValidator = createAjvValidator();

describe('a connection attempt that cannot be established', () => {
  it('ends in an error state carrying the cause', async () => {
    const { states } = await mountAgainstDeadPort();

    const last = states.at(-1);
    expect(last?.status).toBe(CONNECTION_STATUS.error);
    expect(last?.status === CONNECTION_STATUS.error && last.error.message).toContain(
      'could not be established',
    );
  });

  it('makes exactly one attempt — nothing retries here', async () => {
    const { states } = await mountAgainstDeadPort();
    const settled = states.map((state) => state.status);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(states.map((state) => state.status)).toEqual(settled);
    expect(settled.filter((status) => status === CONNECTION_STATUS.connecting)).toHaveLength(1);
  });

  it('leaves the credential out of everything it reports, including the console', async () => {
    const console = recordConsole();
    try {
      const { states } = await mountAgainstDeadPort();
      const reported = states
        .map((state) =>
          state.status === CONNECTION_STATUS.error ? state.error.message : state.status,
        )
        .join('\n');

      expect(reported).not.toContain(TICKET);
      // The console half is the one no error-shaped assertion can make: a message carrying the whole
      // URL never touches the reported error, so every assertion about the error passes while the
      // credential is on screen.
      expect(console.written.join('\n')).not.toContain(TICKET);
    } finally {
      console.restore();
    }
  });

  it('still registers the tool, because registration does not depend on the connection', async () => {
    await mountAgainstDeadPort();

    const host = (
      document as unknown as { modelContext?: { getTools(): Promise<{ name: string }[]> } }
    ).modelContext;
    expect((await host?.getTools())?.map((tool) => tool.name)).toEqual(['offline.tool']);

    cleanup();
  });
});
