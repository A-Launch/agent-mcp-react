// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { closeAll, stack } from './harness.ts';

// Cancellation with a real client on the other end of a real socket, where the question "was a frame
// sent" has an answer rather than an intention.
//
// **The two directions are not symmetrical, and that is the whole point of this file.**
//
//   - The AGENT cancels. Its own client rejects immediately, and the SDK's protocol layer discards
//     whatever the runtime returns. Nothing reaches the agent and nothing needs to.
//   - The PAGE cancels — a tool withdrawn while a call runs. The agent's request is not cancelled and
//     it is still waiting, so the response is both possible and required. Miss it and the agent hangs
//     until its own timeout with nothing to diagnose.
//
// A suite that only tested the first would be green with the second one broken, and the second is the
// one that produces the hang.

afterEach(closeAll);

/** Drains enough turns for a real socket round trip to complete. */
async function settle(turns = 40): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((r) => setImmediate(r));
}

describe('a tool withdrawn while one of its calls is running', () => {
  it('delivers a response the waiting agent actually receives', async () => {
    const under = await stack();

    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const withdraw = await under.register('slow.work', async () => {
      await blocked;
      return { done: true };
    });

    const call = under.client
      .callTool({ name: 'slow.work', arguments: {} })
      .then((result) => result as { isError?: boolean; content?: { text?: string }[] })
      .catch((cause: unknown) => ({ threw: cause }) as never);

    await settle();
    // The page moves on. The agent never cancelled: its request is live and it is still waiting.
    withdraw();

    const settled = await Promise.race([
      call,
      new Promise<'the agent is still waiting'>((resolve) => {
        setTimeout(() => resolve('the agent is still waiting'), 2_000);
      }),
    ]);

    // The assertion this file exists for. Not "the outcome was correct" but "there WAS an outcome" —
    // the failure mode here is silence, and silence looks exactly like a slow page from the far end.
    expect(settled).not.toBe('the agent is still waiting');
    const result = settled as { isError?: boolean; content?: { text?: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain(RUNTIME_FAILURE.callAbandoned);
    // The other half of the pair with the agent-cancelled case below: here a frame really was written.
    expect(
      under.sent.some((message) => JSON.stringify(message).includes(RUNTIME_FAILURE.callAbandoned)),
    ).toBe(true);

    release?.();
  });

  it('does not settle a call of its own accord while the tool is still declared', async () => {
    // The pairing. A runtime that ended every slow call after a turn would pass the case above and
    // would make every genuinely slow handler look withdrawn.
    const under = await stack();

    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await under.register('slow.work', async () => {
      await blocked;
      return { done: true };
    });

    const call = under.client
      .callTool({ name: 'slow.work', arguments: {} })
      .then(() => 'settled')
      .catch(() => 'settled');

    const outcome = await Promise.race([
      call,
      new Promise<'still running'>((resolve) => {
        setTimeout(() => resolve('still running'), 400);
      }),
    ]);
    expect(outcome).toBe('still running');

    release?.();
    await settle();
  });
});

describe('an agent that cancels its own call', () => {
  it('aborts the handler signal and sends nothing back', async () => {
    // Measured, and kept as a standing case because it is an SDK behaviour rather than one of ours: a
    // version bump that started sending a response for a cancelled request would change what
    // `callAbandoned` means on the wire, and the symptom would be a spurious error rather than an
    // error.
    const under = await stack();

    let sawSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await under.register('slow.work', async (_args, context) => {
      sawSignal = context.signal;
      await blocked;
      return { done: true };
    });

    const cancel = new AbortController();
    const call = under.client
      .callTool({ name: 'slow.work', arguments: {} }, { signal: cancel.signal })
      .then(() => 'resolved')
      .catch(() => 'rejected');

    await settle();
    cancel.abort(new Error('changed its mind'));
    await settle();

    // The cancellation crossed the wire and reached the handler.
    expect(sawSignal?.aborted).toBe(true);
    // And the agent's own client already gave up, which is why nothing needs to be sent back.
    expect(await call).toBe('rejected');

    // **Frames, counted.** The client rejecting proves the client gave up; it says nothing about what
    // the page did. Only the wire can distinguish "the SDK discarded our response" from "we sent a
    // response and the client ignored it", and the difference matters: an SDK upgrade that started
    // delivering it would hand every cancelling agent a spurious error.
    const before = under.sent.length;
    release?.();
    await settle();
    expect(under.sent.length).toBe(before);
    expect(under.unexpected).toEqual([]);
  });

  it('leaves an uncancelled call on the same tool completely alone', async () => {
    // The signal is per REQUEST. A composition cached on the ownership entry rather than built per
    // invocation would fail exactly here, and would fail silently: the second call would come back
    // cancelled for no reason a reader could see.
    const under = await stack();

    const seen: AbortSignal[] = [];
    let releaseAll: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    await under.register('slow.work', async (_args, context) => {
      seen.push(context.signal);
      await blocked;
      return { done: true };
    });

    const cancel = new AbortController();
    const cancelled = under.client
      .callTool({ name: 'slow.work', arguments: { which: 'first' } }, { signal: cancel.signal })
      .then(() => 'resolved')
      .catch(() => 'rejected');
    const survivor = under.client
      .callTool({ name: 'slow.work', arguments: { which: 'second' } })
      .then((result) => result as { isError?: boolean })
      .catch((cause: unknown) => ({ threw: cause }) as never);

    await settle();
    expect(seen).toHaveLength(2);

    cancel.abort(new Error('changed its mind'));
    await settle();

    expect(await cancelled).toBe('rejected');
    // The other call's signal never moved.
    expect(seen[1]?.aborted).toBe(false);

    releaseAll?.();
    const result = await survivor;
    expect(result.isError).toBeUndefined();
  });
});

describe('a socket that drops under a call', () => {
  it('aborts the in-flight signal', async () => {
    const under = await stack();

    let sawSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await under.register('slow.work', async (_args, context) => {
      sawSignal = context.signal;
      await blocked;
      return 'done';
    });

    void under.client.callTool({ name: 'slow.work', arguments: {} }).catch(() => undefined);
    await settle();
    expect(sawSignal?.aborted).toBe(false);

    under.dropSocket();
    await settle(60);

    // The channel ending is one of the two causes of cancellation (docs/design.md#cancellation), and
    // it reaches the handler through the
    // same signal a client cancellation does.
    expect(sawSignal?.aborted).toBe(true);
    release?.();
  });
});

describe('the composed signal on the bridged path', () => {
  it('gives the handler a signal that aborts on withdrawal, over a real socket', async () => {
    // **Where `OwnershipEntry.lifetime` and the runtime's composition are actually exercised.**
    //
    // The React suite asserts the same rule through the registry's own callback, which reads the
    // hook's ref directly and never touches the ownership entry or `composeCancellation`. So that
    // file's cases would stay green with the runtime side deleted entirely. This is the bridged path:
    // a real client, a real request signal, composed with a real declaration lifetime.
    const under = await stack();

    let sawSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const withdraw = await under.register('slow.work', async (_args, context) => {
      sawSignal = context.signal;
      await blocked;
      return 'done';
    });

    void under.client.callTool({ name: 'slow.work', arguments: {} }).catch(() => undefined);
    await settle();

    // Before: the request is live, so the composed signal is not aborted. Without this the case would
    // pass for a composition that handed over an already-aborted signal.
    expect(sawSignal?.aborted).toBe(false);

    withdraw();
    await settle();

    expect(sawSignal?.aborted).toBe(true);
    release?.();
  });
});

describe('a call that arrives AFTER the tool was withdrawn', () => {
  it('is refused by name resolution, with a different cause from a cancellation', async () => {
    // The two must not be collapsed (docs/design.md#cancellation), and they are asserted next to each
    // other so that a
    // change that merged them cannot pass. One is a call that never started; the other is a call that
    // did and was stopped, and an agent needs to tell them apart to know whether anything happened.
    const under = await stack();

    const withdraw = await under.register('panel.set', () => 'ok');
    withdraw();
    await settle();

    const result = (await under.client.callTool({ name: 'panel.set', arguments: {} })) as {
      isError?: boolean;
      content?: { text?: string }[];
    };

    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain(RUNTIME_FAILURE.toolNotFound);
    expect(text).not.toContain(RUNTIME_FAILURE.callAbandoned);
    expect(text).not.toContain(RUNTIME_FAILURE.callCancelled);
  });
});
