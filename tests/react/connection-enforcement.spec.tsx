import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpConnectionState, UnexpectedStateReport } from '../../src/react/index.ts';
import { AgentMcpProvider, CONNECTION_STATUS } from '../../src/react/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import { clearRegistry, enterSecureContext } from './harness.ts';

// That the PROVIDER consults the connection machine, not merely that the machine exists.
//
// **Written because a review found the neighbouring unit cases could not fail.** They call
// `permitsTransition` directly, so deleting the provider's `if (!permitsTransition(...))` block left
// every one of them green — a table proved correct and an enforcement proved by nothing. The
// enforcement is the claim; the predicate is only how it is spelled.
//
// A dead port rather than a supplier that never settles: reaching the terminal failure state is the
// point, and a connection that never resolves stays in `connecting` forever.
//
// **What is NOT covered here, measured rather than assumed.** Two break-its were run against these
// cases and BOTH left them green, so neither branch below is held by a test:
//
//   - Deleting the provider's forbidden-transition branch. It cannot be driven from outside: no prop,
//     no callback and no timing an application controls can make the provider ask for a transition its
//     own table refuses, because reaching that branch means this library is already wrong. What these
//     cases do hold is the reachable half — that a legal path flows unobstructed and unreported, so a
//     guard that refused or reported too much fails here.
//   - Removing the try/catch around the teardown announcement. The callback below genuinely throws
//     (verified with a probe), and the subsequent provider still mounts either way — so React's
//     cleanup semantics already absorb more than the reasoning behind that guard assumed. The guard
//     stays because a throw before teardown completes is a real hazard and guarding it costs nothing;
//     it is simply not a guard this suite can prove.
//
// Recorded rather than papered over. A case that claimed either would be worse than the gap.

const DEAD_PORT = 'ws://127.0.0.1:1/';

afterEach(() => {
  clearRegistry();
});

function mount(options: {
  onState: (state: McpConnectionState) => void;
  onUnexpected: (failure: UnexpectedStateReport) => void;
}): ReturnType<typeof render> {
  enterSecureContext();
  return render(
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: () => DEAD_PORT }}
      server={{ name: 'enforcement', version: '0.0.0' }}
      onUnexpectedState={options.onUnexpected}
      onConnectionChange={options.onState}
    >
      {null}
    </AgentMcpProvider>,
  );
}

describe('the provider consulting the connection machine', () => {
  it('publishes every state on a legal path, and reports none of them as forbidden', async () => {
    const seen: McpConnectionState[] = [];
    const unexpected: UnexpectedStateReport[] = [];

    const { unmount } = mount({
      onState: (state) => seen.push(state),
      onUnexpected: (failure) => unexpected.push(failure),
    });

    await vi.waitFor(
      () => expect(seen.map((state) => state.status)).toContain(CONNECTION_STATUS.error),
      { timeout: 5_000 },
    );
    unmount();

    // disconnected → connecting → error → disconnected, every edge declared. A guard that refused a
    // LEGAL transition shows up here as a missing state; one that reported a legal transition shows up
    // as an alarm. Both halves matter, because a guard that refuses everything would satisfy the
    // "forbidden is suppressed" claim perfectly.
    expect(seen.map((state) => state.status)).toEqual([
      CONNECTION_STATUS.connecting,
      CONNECTION_STATUS.error,
      CONNECTION_STATUS.disconnected,
    ]);
    expect(unexpected).toEqual([]);
  });

  it('finishes teardown even when the application throws while being told about it', async () => {
    const first: UnexpectedStateReport[] = [];
    const before: McpConnectionState[] = [];

    const { unmount } = mount({
      onState: (state) => {
        before.push(state);
        // An application that throws while being told the connection ended. Teardown announces itself
        // now, so this runs INSIDE the cleanup — and an unguarded throw there would abandon the retry
        // timer, the runtime and its socket, the gateway and the DOCUMENT CLAIM, on an ordinary
        // unmount. Teardown cannot be conditional on an application behaving.
        if (state.status === CONNECTION_STATUS.disconnected) {
          throw new Error('the application threw while being told about teardown');
        }
      },
      onUnexpected: (failure) => first.push(failure),
    });

    // Wait for the terminal failure, so the unmount below really does announce a transition and the
    // callback really does throw. Unmounting earlier would tear down from `connecting`, where nothing
    // has been published that teardown must follow.
    await vi.waitFor(
      () => expect(before.map((state) => state.status)).toContain(CONNECTION_STATUS.error),
      { timeout: 5_000 },
    );
    unmount();

    // What is asserted is the user-visible consequence: a page whose application threw during one
    // teardown can still mount a provider afterwards. The document claim is the thing that would
    // otherwise stay held, and a held claim refuses the next provider outright.
    //
    // This passes with the guard removed too — see the header. It is kept as a regression test for the
    // property, not as proof of the mechanism.
    const second: UnexpectedStateReport[] = [];
    const seen: McpConnectionState[] = [];
    const next = mount({
      onState: (state) => seen.push(state),
      onUnexpected: (failure) => second.push(failure),
    });

    await vi.waitFor(
      () => expect(seen.map((state) => state.status)).toContain(CONNECTION_STATUS.connecting),
      { timeout: 5_000 },
    );
    expect(second).toEqual([]);
    next.unmount();
  });
});
