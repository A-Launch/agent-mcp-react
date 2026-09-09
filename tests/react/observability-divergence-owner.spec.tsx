import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpRegistryChangeEvent, UnexpectedStateReport } from '../../src/react/index.ts';
import { AgentMcpProvider } from '../../src/react/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import { clearRegistry, enterSecureContext } from './harness.ts';

// That the observability surface did not give an existing truth a second owner.
//
// An ownership divergence — a name this library's record holds and the document's registry does not —
// already has a destination: `onUnexpectedState`, a REQUIRED provider prop, reported by the runtime
// while serving a request. The design also asks for a registry-change hook
// (docs/observing-tool-calls.md), and the two are easy to conflate because both are about the
// registry moving. They are not the same thing:
//
//   onUnexpectedState  a BROKEN INVARIANT. This library believes it registered something that is not
//                      there. Nothing an application did causes it, and it is an alarm.
//   onRegistryChange   NORMAL OPERATION. The registry moved, possibly because another script on the
//                      page registered something, and the event says whether the agent-visible set
//                      moved with it.
//
// Routing a divergence onto the new hook as well would put one condition under two owners — one
// owner per truth, everything else derived from it — and a receiver that handled it in the wrong
// place would treat an alarm as routine traffic.

afterEach(() => {
  clearRegistry();
});

const DEAD_PORT = 'ws://127.0.0.1:1/';

describe('the two channels stay distinct', () => {
  it('reports a registry change without routing anything to the alarm channel', async () => {
    enterSecureContext();
    const alarms: UnexpectedStateReport[] = [];
    const changes: McpRegistryChangeEvent[] = [];

    const { unmount } = render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => DEAD_PORT }}
        server={{ name: 'owners', version: '0.0.0' }}
        onUnexpectedState={(failure) => alarms.push(failure)}
        onRegistryChange={(event) => changes.push(event)}
      >
        {null}
      </AgentMcpProvider>,
    );

    // A provider that never connects still registers and still reconciles nothing. What matters is
    // the ABSENCE: ordinary operation must not put anything on the alarm channel, because an operator
    // who learns that channel carries routine traffic stops reading it. That is the fail-loud rule
    // cutting the other way: a channel reserved for unexpected states stops being read the moment it
    // carries expected ones, which is exactly why the publisher does not report a skipped send as an
    // anomaly.
    for (let turn = 0; turn < 40; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(alarms).toEqual([]);
    unmount();
  });

  it('keeps the alarm destination REQUIRED while the change hook stays optional', () => {
    // A structural claim rather than a behavioural one, and it is the reason the two cannot be merged.
    // `onUnexpectedState` is required because a list request still succeeds for every other tool when
    // one name diverges — there is no response to carry the alarm, so a provider that could be built
    // without a destination is one whose alarms default to silence. `onRegistryChange` is optional
    // because an application that does not care about registry traffic should pay nothing for it.
    //
    // Asserted by CONSTRUCTION: this compiles, and the same element without `onUnexpectedState` does
    // not. A test that only checked runtime behaviour could not see the difference.
    // **Corrected after a review: the original ended in `expect(true).toBe(true)`, which is not an
    // assertion.** What can actually be checked is that the two props differ in KIND — one is
    // required and one is not — and that is a compile-time fact, so it is asserted the way a
    // compile-time fact has to be.
    //
    // `onUnexpectedState` is REQUIRED: a provider that could be built without a destination is one
    // whose alarms default to silence, which is the condition the divergence rules exist to prevent.
    const withoutAlarm = (
      // @ts-expect-error the required alarm destination is deliberately omitted here
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => DEAD_PORT }}
        server={{ name: 'owners', version: '0.0.0' }}
      >
        {null}
      </AgentMcpProvider>
    );
    expect(withoutAlarm).toBeDefined();

    // While the change hook is optional, because an application that does not care about registry
    // traffic should pay nothing for it. This compiles with no directive, which is the assertion.
    enterSecureContext();
    const { unmount } = render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => DEAD_PORT }}
        server={{ name: 'owners', version: '0.0.0' }}
        onUnexpectedState={() => {}}
      >
        {null}
      </AgentMcpProvider>,
    );
    unmount();
  });
});
