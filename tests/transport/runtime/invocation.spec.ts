// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { closeAll, stack } from './harness.ts';

// What happens when a handler misbehaves, and why each of these is a case rather than a comment.
//
// The two most valuable ones guard against failures that produce no error anywhere:
//
//   - An uncaught throw reaches the agent as a PROTOCOL error carrying the application's own message.
//     The connection survives and the agent gets something, and both are wrong: it is the wrong error
//     kind for a model to react to, and the message was never ours to publish.
//   - An unserializable result produces ZERO frames. No response, no error, no rejection. The agent
//     blocks on that request until its own timeout and concludes the page is slow. Measured, not
//     imagined — research R4.

afterEach(closeAll);

/** The text of a tool result, which is the only channel until output schemas exist. */
function textOf(result: { content?: unknown }): string {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((block) => block.text ?? '').join('');
}

describe('a handler that fails', () => {
  it('produces a tool error rather than a protocol error', async () => {
    const page = await stack();
    await page.register('will.throw', () => {
      throw new Error('the handler exploded');
    });

    // `callTool` RESOLVES here, and that is the assertion: a protocol error would reject, and a model
    // cannot see or react to one — a tool error says the tool ran and failed, which it can.
    const result = await page.client.callTool({ name: 'will.throw', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(RUNTIME_FAILURE.toolExecutionFailed);
  });

  it('behaves identically when it rejects after a delay', async () => {
    const page = await stack();
    await page.register('will.reject', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error('late failure');
    });

    const result = await page.client.callTool({ name: 'will.reject', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(RUNTIME_FAILURE.toolExecutionFailed);
  });

  it('leaves the connection serving every other tool', async () => {
    const page = await stack();
    await page.register('will.throw', () => {
      throw new Error('boom');
    });
    await page.register('still.works', () => 'fine');

    await page.client.callTool({ name: 'will.throw', arguments: {} });

    // One tool failing is not an outage. Asserted as the NEXT call succeeding, rather than as the
    // socket still being open — an escaped protocol error would leave the socket open too.
    const after = await page.client.callTool({ name: 'still.works', arguments: {} });
    expect(after.isError).toBeFalsy();
    expect(textOf(after)).toBe('fine');
  });
});

describe('a result that cannot be sent', () => {
  it('becomes a tool error instead of silence', async () => {
    const page = await stack();
    await page.register('returns.a.cycle', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      return cyclic;
    });

    // What this guards is not a wrong answer — it is NO answer. Without the check the response is
    // never sent: zero frames, no error, no rejection. So the meaningful part of this case is that it
    // completes at all rather than timing out.
    const result = await page.client.callTool({ name: 'returns.a.cycle', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(RUNTIME_FAILURE.resultNotSerializable);
  });

  it('still serves the next call afterwards', async () => {
    const page = await stack();
    await page.register('returns.a.cycle', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      return cyclic;
    });
    await page.register('fine', () => 'ok');

    await page.client.callTool({ name: 'returns.a.cycle', arguments: {} });
    expect(textOf(await page.client.callTool({ name: 'fine', arguments: {} }))).toBe('ok');
  });

  it('treats a handler that returns nothing as a success', async () => {
    const page = await stack();
    let ran = false;
    await page.register('returns.nothing', () => {
      ran = true;
    });

    const result = await page.client.callTool({ name: 'returns.nothing', arguments: {} });

    // A tool whose whole effect was the mutation it performed has nothing to say. Reporting that as a
    // failure would push applications to invent return values.
    expect(ran).toBe(true);
    expect(result.isError).toBeFalsy();
  });
});

describe('what a handler is given', () => {
  it('receives the call arguments and a context carrying a real abort signal', async () => {
    let seen: { args: Record<string, unknown>; aborted: boolean; isSignal: boolean } | undefined;
    const page = await stack();
    await page.register('inspects.context', (args, context) => {
      seen = {
        args,
        aborted: context.signal.aborted,
        isSignal: typeof context.signal.addEventListener === 'function',
      };
      return 'ok';
    });

    await page.client.callTool({ name: 'inspects.context', arguments: { a: 1, b: 'two' } });

    expect(seen?.args).toEqual({ a: 1, b: 'two' });
    // A real signal rather than a placeholder: it comes from the protocol layer's per-request
    // controller, reached at `extra.mcpReq.signal` — not where the specification says to look.
    expect(seen?.isSignal).toBe(true);
    expect(seen?.aborted).toBe(false);
  });

  it('aborts that signal when the client cancels the request', async () => {
    const page = await stack();
    let abortedDuringCall = false;

    await page.register('slow', async (_args, context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => {
          abortedDuringCall = true;
          resolve();
        });
        setTimeout(resolve, 2_000);
      });
      return 'finished';
    });

    const controller = new AbortController();
    // Two arguments, not three: `callTool(params, options)`. A signal passed in a third slot is
    // silently ignored — written that way first, this case failed because the client never cancelled
    // at all. Worth knowing: the shape changed between major versions, like the abort signal's own
    // location did.
    const call = page.client
      .callTool({ name: 'slow', arguments: {} }, { signal: controller.signal })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await call;
    await new Promise((resolve) => setTimeout(resolve, 50));

    // This is what makes the signal the platform's rather than a decoration. A signal this library
    // created would never learn that the client cancelled.
    expect(abortedDuringCall).toBe(true);
  });
});
