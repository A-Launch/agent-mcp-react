import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMcpProvider, useMcpTool } from '../../src/react/index.ts';
import { RUNTIME_FAILURE } from '../../src/runtime/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  boundary,
  clearRegistry,
  enterSecureContext,
  neverConnects,
  recorder,
  registeredNames,
  until,
} from './harness.ts';

// A tool declaring a schema with no validator installed — the first mistake a second tool invites,
// because the import is easy to forget and the first tool did not need one.
//
// **Reported from a first integration as "a blank page".** That is what it was: the refusal threw from
// the provider's render, so the console message naming the exact import to add sat underneath a tree
// that no longer rendered. The rule this library is built on decides the question — MCP is a SECOND
// control interface onto one application, and a misconfigured second interface must not take down the
// first. A person's UI does not stop working because an agent's did.
//
// What these cases hold onto is that nothing was traded for it: the tool is still not registered.

beforeEach(() => {
  clearRegistry();
  enterSecureContext();
});
afterEach(() => {
  clearRegistry();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Loads the library as the named build would have it.
 *
 * The console channel exists only in development, and vitest runs as `NODE_ENV=test` — so a case
 * asserting it against the default import asserts nothing. This one did, and passed anyway, because
 * React logs a caught error itself and that log carried our message. Removing the throw is what
 * exposed it.
 */
async function libraryBuiltFor(mode: 'development' | 'production') {
  vi.stubEnv('NODE_ENV', mode);
  vi.resetModules();
  return import('../../src/react/index.ts');
}

function schemaWithoutValidator(
  seen: ReturnType<typeof recorder>,
  built?: typeof import('../../src/react/index.ts'),
): React.ReactNode {
  const Provider = built?.AgentMcpProvider ?? AgentMcpProvider;
  const declare = built?.useMcpTool ?? useMcpTool;
  function Tool(): null {
    declare({
      name: 'board.set_filter',
      description: 'needs a validator it will not get',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      handler: () => ({}),
    });
    return null;
  }
  return (
    <Provider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: neverConnects }}
      server={{ name: 'page', version: '0.0.0' }}
      onUnexpectedState={(failure) => seen.unexpected.push(failure)}
      onRegistration={(event) => seen.refused.push(event)}
    >
      <Tool />
    </Provider>
  );
}

describe('a tool that declares a schema with no validator installed', () => {
  it('leaves the application mounted rather than tearing it down', async () => {
    const seen = recorder();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(boundary(seen, schemaWithoutValidator(seen)));

    await until(() => seen.refused.length > 0, 'the refusal to be reported');
    // The whole point: no error boundary fired, and the tree is still there.
    expect(seen.caught).toEqual([]);
    expect(view.container.isConnected).toBe(true);
  });

  it('is still NOT registered — refused means refused', async () => {
    const seen = recorder();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(boundary(seen, schemaWithoutValidator(seen)));

    await until(() => seen.refused.length > 0, 'the refusal to be reported');
    // Surviving the refusal must not mean surviving it into the registry. A tool registered with a
    // contract nothing enforces is the state the validation feature exists to end, and it would be
    // callable by every script on the page.
    expect(await registeredNames()).toEqual([]);
  });

  it('reports the refusal with the code that names the cause', async () => {
    const seen = recorder();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(boundary(seen, schemaWithoutValidator(seen)));

    await until(() => seen.refused.length > 0, 'the refusal to be reported');
    expect(seen.refused[0]?.code).toBe(RUNTIME_FAILURE.validatorMissing);
    expect(seen.refused[0]?.name).toBe('board.set_filter');
  });

  it('says so on the console too, in development, for an author who wired no observer', async () => {
    const built = await libraryBuiltFor('development');
    const seen = recorder();
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    render(boundary(seen, schemaWithoutValidator(seen, built)));

    await until(() => errors.length > 0, 'the refusal to reach the console');
    // `onRegistration` is optional. Without this an author who wired nothing would see a tool missing
    // and nothing anywhere saying why — which is the condition the throw was protecting against, and
    // the one this channel now has to carry on its own.
    const said = errors.flat().map(String).join(' ');
    expect(said).toContain('board.set_filter');
    expect(said).toContain('createAjvValidator');
  });
});
