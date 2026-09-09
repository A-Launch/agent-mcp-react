import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModel } from '../../../tools/mock-agent/src/model.ts';

// The request the chat agent sends to the Messages API, asserted against the contract rather than
// against a live endpoint.
//
// This layer exists because the failure it catches is expensive and late: a malformed body is refused
// by the API for the whole request, so ONE bad tool schema silently costs the agent every tool it had.
// A key is not available in CI or on most machines here, and a test that needs one is a test nobody
// runs — so `fetch` is stubbed and the body is inspected. What this cannot prove is that the API
// accepts what is asserted here; that is a live check, recorded as such.

const KEY = 'test-key-not-real';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Captures the one request `complete` makes and answers with a minimal valid reply. */
function captureRequest(): { seen: { url: string; init: RequestInit }[] } {
  const seen: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  });
  return { seen };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('the request the chat agent builds', () => {
  it('is the Messages API shape, with the version header and the key', async () => {
    const { seen } = captureRequest();
    const model = createModel({ ANTHROPIC_API_KEY: KEY } as NodeJS.ProcessEnv);

    await model.complete({
      system: 'you drive a page',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'a__b', description: 'a', input_schema: { type: 'object', properties: {} } }],
    });

    const [request] = seen;
    expect(request?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = request?.init.headers as Record<string, string>;
    // The version header is required, and its absence is a 400 rather than a default.
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-api-key']).toBe(KEY);

    const body = bodyOf(request?.init as RequestInit);
    expect(Object.keys(body).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'system',
      'tools',
    ]);
    expect(typeof body.system).toBe('string');
  });

  it('omits `tools` entirely rather than sending an empty array', async () => {
    const { seen } = captureRequest();
    const model = createModel({ ANTHROPIC_API_KEY: KEY } as NodeJS.ProcessEnv);

    await model.complete({ system: 's', messages: [], tools: [] });

    // An empty tools array is not the same statement as no tools, and the API is entitled to treat
    // it differently. Nothing here is asserting it does — the point is not to find out the hard way.
    expect(bodyOf(seen[0]?.init as RequestInit)).not.toHaveProperty('tools');
  });

  it('honours a base URL override, which is how the path is exercised without a live endpoint', async () => {
    const { seen } = captureRequest();
    const model = createModel({
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:45030',
      AMR_MODEL: 'stub',
    } as NodeJS.ProcessEnv);

    await model.complete({ system: 's', messages: [], tools: [] });

    expect(seen[0]?.url).toBe('http://127.0.0.1:45030/v1/messages');
    expect(bodyOf(seen[0]?.init as RequestInit).model).toBe('stub');
  });

  it('carries the API’s own message into the failure, because the fixes differ', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'model: unknown model name' } }), {
          status: 404,
        }),
      ),
    );
    const model = createModel({ ANTHROPIC_API_KEY: KEY } as NodeJS.ProcessEnv);

    // An unknown model, an exhausted balance and a malformed schema are three different problems with
    // three different fixes. Collapsing them into "the model call failed" costs the operator all of it.
    await expect(model.complete({ system: 's', messages: [], tools: [] })).rejects.toThrow(
      'unknown model name',
    );
  });
});

describe('the model reports its own absence', () => {
  it('is unavailable with no key, and says what to do about it', () => {
    const model = createModel({} as NodeJS.ProcessEnv);

    expect(model.available).toBe(false);
    expect(model.reason).toContain('ANTHROPIC_API_KEY');
    // The name is still reported, so a page can show which model it WOULD use.
    expect(model.name).toBe('claude-sonnet-5');
  });

  it('never reaches the network when it has no key', async () => {
    const reached = vi.fn();
    vi.stubGlobal('fetch', reached);
    const model = createModel({ ANTHROPIC_API_KEY: '' } as NodeJS.ProcessEnv);

    await expect(model.complete({ system: 's', messages: [], tools: [] })).rejects.toThrow();
    expect(reached).not.toHaveBeenCalled();
  });

  it('keeps the key out of everything it hands back', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('upstream exploded', { status: 500 })),
    );
    const model = createModel({ ANTHROPIC_API_KEY: KEY } as NodeJS.ProcessEnv);

    // The failure text reaches an operator's console and, through the chat, a browser. A credential
    // echoed into it would be published by the reporting path itself.
    const failure = await model
      .complete({ system: 's', messages: [], tools: [] })
      .catch((cause: unknown) => String(cause));
    expect(failure).not.toContain(KEY);
    expect(JSON.stringify(model)).not.toContain(KEY);
  });
});
