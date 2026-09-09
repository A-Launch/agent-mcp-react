import { describe, expect, it } from 'vitest';
import type { ListedTool } from '../../../src/runtime/listing.ts';
import { createToolListPublisher } from '../../../src/runtime/tool-list-publication.ts';

// The sequence that only a reconnection produces: a close, an open and a change signalled while a
// publication pass is still unwinding.
//
// **This was a latent defect fixed ahead of the feature that could reach it.** A pass returns early
// when its epoch closes, and the flag saying "a pass is running" stays set until its own continuation
// runs — so a close, an open and a signal landing in that window left work flagged with nobody draining.
// No further pass, nothing sent, and the agent silently stale for the life of the connection.
//
// It was unreachable while a runtime connected exactly once, because that exact ordering IS a
// reconnection — and a fix nothing exercises is a fix nobody knows still works.

function tool(name: string): ListedTool {
  return { name, description: name, inputSchema: { type: 'object', properties: {} } } as ListedTool;
}

describe('a change signalled while a pass is unwinding across a reconnection', () => {
  it('is still delivered, rather than left flagged with nobody draining', async () => {
    let current: readonly ListedTool[] = [tool('before.drop')];
    let sends = 0;
    let releaseSend: (() => void) | undefined;

    const publisher = createToolListPublisher({
      derive: () => Promise.resolve(current),
      send: () => {
        sends += 1;
        // The first send is held open, so the close/open/signal below lands while the pass is still
        // unwinding — which is the whole window this case exists for.
        return sends === 1
          ? new Promise<void>((resolve) => {
              releaseSend = resolve;
            })
          : Promise.resolve();
      },
      onSendFailed: () => undefined,
    });

    await publisher.open();
    current = [tool('before.drop'), tool('added.while.connected')];
    publisher.signal();

    // Give the pass a turn to start and reach the held send.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The reconnection, landing inside that window.
    publisher.close();
    await publisher.open();
    current = [tool('mounted.while.disconnected')];
    publisher.signal();

    // Now let the first pass finish unwinding. Its epoch is closed, so it delivers nothing itself —
    // and the question is whether the work queued behind it is picked up.
    releaseSend?.();

    // A further send, for the change signalled on the NEW connection. Without the restart-in-finally
    // the flag stays set with nobody draining and this never arrives.
    await expect.poll(() => sends, { timeout: 1_000 }).toBeGreaterThan(1);

    publisher.close();
  });
});
