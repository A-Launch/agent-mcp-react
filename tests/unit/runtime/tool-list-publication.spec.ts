import { describe, expect, it } from 'vitest';
import type { ListedTool } from '../../../src/runtime/listing.ts';
import {
  createToolListPublisher,
  type ToolListPublisher,
  tokenFor,
} from '../../../src/runtime/tool-list-publication.ts';

// The publication decision, with no registry, no socket and no renderer.
//
// Everything here is about WHEN the agent is told. That the notification reaches it at all is a
// transport-layer property and is asserted there, against a real client — a case here that mocked the
// send and concluded "delivery works" would be a test of the mock.

function tool(name: string, over: Partial<ListedTool> = {}): ListedTool {
  return {
    name,
    description: `the ${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    ...over,
  };
}

describe('the comparison token', () => {
  it('is the same for the same tools in a different order', () => {
    // The registry promises no enumeration order. A reordering an agent could not observe must not
    // produce a notification.
    expect(tokenFor([tool('a'), tool('b')])).toBe(tokenFor([tool('b'), tool('a')]));
  });

  it('is the same for one schema written with its keys in a different order', () => {
    const one = tool('a', {
      inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    });
    const other = tool('a', {
      inputSchema: { required: ['x'], properties: { x: { type: 'string' } }, type: 'object' },
    });

    // Key order is not significant in JSON Schema. Two spellings of one schema are one schema, and
    // `JSON.stringify` on the raw objects would call them different — a notification on every render
    // that happened to build the object differently.
    expect(tokenFor([one])).toBe(tokenFor([other]));
  });

  it('differs when a description changes, though the names are identical', () => {
    // The case for comparing the whole listing rather than the set of names. A stale description is a
    // stale instruction to a model, and nothing about it looks wrong.
    expect(tokenFor([tool('a')])).not.toBe(tokenFor([tool('a', { description: 'changed' })]));
  });

  it('differs when an input schema changes, though the names are identical', () => {
    // The sharper half of the same point: a model choosing arguments from a stale schema fails in a
    // way that reads as the model's mistake.
    const before = tokenFor([tool('a')]);
    const after = tokenFor([
      tool('a', { inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }),
    ]);
    expect(before).not.toBe(after);
  });

  it('differs when a title appears, and a present-but-undefined title is an absent one', () => {
    expect(tokenFor([tool('a')])).not.toBe(tokenFor([tool('a', { title: 'A' })]));

    // A key set to `undefined` and an absent key mean the same thing and must produce one token.
    // `exactOptionalPropertyTypes` stops this being expressible through the typed helper, which is
    // the point — the value can only arrive here from an untyped boundary, and that is exactly where
    // it would otherwise cause a notification for a change nobody made.
    const withUndefinedKey = { ...tool('a'), title: undefined } as unknown as ListedTool;
    expect(tokenFor([withUndefinedKey])).toBe(tokenFor([tool('a')]));
  });

  it('is a string, and carries nothing a caller could turn back into tools', () => {
    // Structural guard for the one-owner-per-truth argument in the module header: what is retained
    // cannot answer
    // "what tools exist", because it is not a listing and there is no way back from it.
    const token = tokenFor([tool('a'), tool('b')]);
    expect(typeof token).toBe('string');
    expect(() => (token as unknown as ListedTool[]).map((t) => t.name)).toThrow();
  });
});

/** A publisher whose derivation and send are driven by the case. */
function harness(initial: readonly ListedTool[] = []) {
  let tools = [...initial];
  const sends: Array<{ resolve: () => void; reject: (cause: unknown) => void }> = [];
  const failures: unknown[] = [];
  let sendCount = 0;
  let autoResolve = true;

  const publisher: ToolListPublisher = createToolListPublisher({
    derive: () => Promise.resolve([...tools]),
    send: () => {
      sendCount += 1;
      if (autoResolve) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        sends.push({ resolve, reject });
      });
    },
    onSendFailed: (cause) => failures.push(cause),
  });

  return {
    publisher,
    failures,
    sendCount: () => sendCount,
    setTools(next: readonly ListedTool[]) {
      tools = [...next];
    },
    /** Makes the next sends hang until the case releases them. */
    holdSends() {
      autoResolve = false;
    },
    releaseSends() {
      autoResolve = true;
      for (const held of sends.splice(0)) held.resolve();
    },
    failNextSend(cause: unknown) {
      const held = sends.shift();
      if (held === undefined) throw new Error('no send is in flight to fail');
      held.reject(cause);
    },
    /** The number of sends currently awaiting release. */
    inFlight: () => sends.length,
  };
}

describe('deciding whether to speak', () => {
  it('says nothing when the projection has not changed', async () => {
    const page = harness([tool('a')]);
    // `open()` establishes the baseline without sending. What the agent sees on its first `tools/list`
    // is what the publisher now believes it has been told.
    await page.publisher.open();

    page.publisher.signal();
    page.publisher.signal();
    await page.publisher.settled();

    // **This case previously asserted the opposite** — that the first signal always sends, "to
    // establish the token" — which encoded a defect as intent. With no baseline, `open()` followed by
    // a change that changes nothing (a cleanup removing a name that was never registered, on a page
    // with no tools) told the agent its tool set had changed when it had not.
    expect(page.sendCount()).toBe(0);
  });

  it('speaks once when the projection changed', async () => {
    const page = harness([tool('a')]);
    await page.publisher.open();

    page.setTools([tool('a'), tool('b')]);
    page.publisher.signal();
    await page.publisher.settled();

    expect(page.sendCount()).toBe(1);
  });

  it('says nothing when a change arrives that leaves the visible set identical', async () => {
    // The concrete shape of the defect the baseline fixes: a cleanup removing a name that was never
    // registered, on a page whose tool set is unchanged. Before the baseline existed this sent a
    // notification, and an agent re-listed to find nothing different.
    const page = harness([]);
    await page.publisher.open();

    page.publisher.signal();
    await page.publisher.settled();

    expect(page.sendCount()).toBe(0);
  });

  it('says nothing before it is open, and reports nothing either', async () => {
    const page = harness([tool('a')]);
    page.publisher.signal();
    await page.publisher.settled();

    // Tools register at mount, which can complete before the socket does. That is the ordinary path,
    // not a failure — the agent's first listing is its starting picture.
    expect(page.sendCount()).toBe(0);
    expect(page.failures).toEqual([]);
  });

  it('says nothing after it is closed, and reports nothing either', async () => {
    const page = harness([tool('a')]);
    page.publisher.open();
    page.publisher.close();

    page.setTools([tool('a'), tool('b')]);
    page.publisher.signal();
    await page.publisher.settled();

    // An unmount is not an anomaly. Reporting one as an unexpected state would train an operator to
    // ignore the channel that carries real ones.
    expect(page.sendCount()).toBe(0);
    expect(page.failures).toEqual([]);
  });
});

describe('a signal arriving while a notification is in flight', () => {
  it('is not dropped — it causes another derivation and another send', async () => {
    // **The case this feature turns on.** Without the dirty bit, the second signal is swallowed as
    // "already sending": the agent is told about the half-built set, re-lists it, the rest of the
    // tools register, and NOTHING further is owed to it. It is then permanently stale and no channel
    // anywhere reports that it is. This is the ordinary shape of a route change, not an edge case —
    // the withdrawals fire one registry event and the registrations fire another.
    const page = harness([tool('a')]);
    await page.publisher.open();
    page.holdSends();

    page.setTools([tool('a'), tool('b')]);
    page.publisher.signal();
    await Promise.resolve();
    await Promise.resolve();
    expect(page.inFlight()).toBe(1);

    // The second wave lands while the first notification is still in flight.
    page.setTools([tool('a'), tool('b'), tool('c')]);
    page.publisher.signal();

    page.releaseSends();
    await page.publisher.settled();

    expect(page.sendCount()).toBe(2);
  });

  it('collapses several signals during one send into exactly one further pass', async () => {
    const page = harness([tool('a')]);
    await page.publisher.open();
    page.holdSends();

    page.setTools([tool('a'), tool('x')]);
    page.publisher.signal();
    await Promise.resolve();
    await Promise.resolve();

    page.setTools([tool('a'), tool('b')]);
    page.publisher.signal();
    page.publisher.signal();
    page.publisher.signal();

    page.releaseSends();
    await page.publisher.settled();

    // Three signals describing one change. The agent hears about the change, once — the drain
    // re-derives and finds one difference, not three.
    expect(page.sendCount()).toBe(2);
  });
});

describe('a send that fails', () => {
  it('does not advance the token, so the next genuine change is still sent', async () => {
    const page = harness([tool('a')]);
    await page.publisher.open();
    page.holdSends();

    page.setTools([tool('a'), tool('b')]);
    page.publisher.signal();
    await Promise.resolve();
    await Promise.resolve();
    page.failNextSend(new Error('the socket went away mid-send'));
    await page.publisher.settled();

    // Reported, because the publisher believed it could send. Silence here is the hidden unknown.
    expect(page.failures).toHaveLength(1);

    page.releaseSends();
    page.publisher.signal();
    await page.publisher.settled();

    // The retry is not a retry — it is the next signal finding the token still unadvanced, because a
    // token advanced on a failed send would make this change compare equal to something the agent was
    // never told.
    expect(page.sendCount()).toBe(2);
  });
});

describe('a reporting destination that itself throws', () => {
  it('is called once and takes nothing down with it', async () => {
    let reports = 0;
    let tools = [tool('a')];
    const held: Array<{ reject: (cause: unknown) => void }> = [];
    const publisher = createToolListPublisher({
      derive: () => Promise.resolve([...tools]),
      send: () => new Promise<void>((_, reject) => held.push({ reject })),
      onSendFailed: () => {
        reports += 1;
        // The destination is application-supplied — it reaches `onUnexpectedState` — so it can throw.
        throw new Error('the operator\u2019s own reporter is broken');
      },
    });

    await publisher.open();
    tools = [tool('a'), tool('b')];
    publisher.signal();
    await Promise.resolve();
    await Promise.resolve();
    held.shift()?.reject(new Error('send failed'));
    await publisher.settled();

    // Once. Before this was fenced, the throw escaped the drain, the outer wrapper called the same
    // throwing destination again, and an unhandled rejection was left behind — a reporting path that
    // fails louder than the thing it reports.
    expect(reports).toBe(1);
  });
});

describe('the epoch', () => {
  it('still speaks when a reconnection lands while a pass is unwinding', async () => {
    // A drain returns early when its epoch closes underneath it, and `draining` stays true until its
    // `finally` runs. A close/open/signal landing in that window sets `dirty` with nobody draining —
    // and unless a finished pass restarts itself, the agent is never told and nothing reports it.
    //
    // This is what a reconnection is. It is unreachable today because a runtime connects once, and it
    // would have shipped straight into the first reconnection.
    const page = harness([tool('a')]);
    await page.publisher.open();
    page.holdSends();

    page.setTools([tool('a'), tool('b')]);
    page.publisher.signal();
    await Promise.resolve();
    await Promise.resolve();
    expect(page.inFlight()).toBe(1);

    // The connection goes away and comes back while that first pass is still in flight.
    page.publisher.close();
    await page.publisher.open();
    page.setTools([tool('a'), tool('b'), tool('c')]);
    page.publisher.signal();

    page.releaseSends();
    // Awaited ONCE. `settled()` now means "no pass running and none queued" — a case that had to
    // await twice was working around its subject rather than testing it.
    await page.publisher.settled();

    expect(page.sendCount()).toBeGreaterThanOrEqual(2);
  });

  it('re-baselines on a new connection rather than carrying the old one\u2019s token', async () => {
    const page = harness([tool('a')]);
    await page.publisher.open();

    page.setTools([tool('a'), tool('b')]);
    page.publisher.signal();
    await page.publisher.settled();
    expect(page.sendCount()).toBe(1);

    // A new connection. Its baseline is taken fresh, so an unchanged set costs the new agent nothing
    // — it will read that set in its own first `tools/list` — while a set that changed while
    // disconnected is still reported.
    page.publisher.close();
    await page.publisher.open();
    page.publisher.signal();
    await page.publisher.settled();
    expect(page.sendCount()).toBe(1);

    page.setTools([tool('a'), tool('b'), tool('c')]);
    page.publisher.signal();
    await page.publisher.settled();
    expect(page.sendCount()).toBe(2);
  });
});
