import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGISTRATION_REFUSED } from '../../src/webmcp/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  boundary,
  clearRegistry,
  codeOf,
  enterSecureContext,
  neverConnects,
  recorder,
  registeredNames,
  until,
} from './harness.ts';

// Two mounted components of one application claiming one name — and what each build does about it.
//
// The conflict is reported in BOTH builds. Only the consequence differs: development stops the author
// at the moment they can fix it and says where, while production rejects the later registration,
// leaves the original callable, and tells the operator. A production build that tore a page down
// because a screen was mounted twice would be a worse outcome than the collision it is reporting.
//
// **The build mode is a module-level constant**, resolved once so a bundler can fold the comparison
// and drop the dead branch. That is why these cases re-import the library after stubbing the flag,
// rather than toggling something at runtime — there is nothing to toggle, and a build-mode reader that
// could be changed at runtime would defeat the elimination it exists to allow.

beforeEach(() => {
  clearRegistry();
  enterSecureContext();
});
afterEach(() => {
  clearRegistry();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Loads the library as the named build would have it.
 *
 * The library reads two flags, and it reads both for a measured reason: a Node-side build says
 * `NODE_ENV`, while a browser bundler says `import.meta.env.DEV` — and in a browser dev session
 * `process` does not exist at all, so a library reading only the first answers "production" in every
 * browser development session, which is exactly where the development behaviour is meant to be.
 *
 * Stubbing `NODE_ENV` is enough here because an explicitly set one decides on its own. That precedence
 * exists so this runner's always-true `DEV` cannot make the production branch unreachable.
 */
async function libraryBuiltFor(mode: 'development' | 'production') {
  vi.stubEnv('NODE_ENV', mode);
  vi.resetModules();
  return import('../../src/react/index.ts');
}

function twoClaims(
  AgentMcpProvider: typeof import('../../src/react/index.ts').AgentMcpProvider,
  useMcpTool: typeof import('../../src/react/index.ts').useMcpTool,
  seen: ReturnType<typeof recorder>,
): ReactNode {
  function Tool(): null {
    useMcpTool({ name: 'contested.name', description: 'claimed twice', handler: () => ({}) });
    return null;
  }
  return (
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: neverConnects }}
      server={{ name: 'colliding-page', version: '0.0.0' }}
      onUnexpectedState={(failure) => seen.unexpected.push(failure)}
      onRegistration={(event) => seen.refused.push(event)}
    >
      <Tool />
      <Tool />
    </AgentMcpProvider>
  );
}

describe('a development build', () => {
  it('reports the refusal and leaves the application standing', async () => {
    // **This used to throw from the provider's render, and the page went white.** The console message
    // named the exact fix and sat underneath a tree that no longer rendered — a first integration
    // reported it as a blank page rather than as the refusal it was.
    //
    // The rule the library is built on decides it: MCP is a SECOND control interface onto one
    // application, and a misconfigured second interface must not take down the first. Production
    // already worked this way; development, where the author actually is, did not.
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('development');
    const seen = recorder();
    const view = render(boundary(seen, twoClaims(AgentMcpProvider, useMcpTool, seen)));

    await until(() => seen.refused.length > 0, 'the refusal to be reported');
    // Nothing was torn down.
    expect(seen.caught).toEqual([]);
    expect(view.container.isConnected).toBe(true);
    // And refused still means refused: one claimant holds the name, the other never became a tool.
    expect(await registeredNames()).toEqual(['contested.name']);
  });

  it('says the application collided with itself, never that a foreign script holds the name', async () => {
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('development');
    const seen = recorder();
    render(boundary(seen, twoClaims(AgentMcpProvider, useMcpTool, seen)));

    await until(() => seen.refused.length > 0, 'the refusal to be reported');
    // An author told "a foreign script holds this" goes looking outside their own code for a conflict
    // that is not there.
    expect(seen.refused[0]?.code).toBe(REGISTRATION_REFUSED.nameHeldByThisApplication);
    expect(seen.refused[0]?.code).not.toBe(REGISTRATION_REFUSED.nameHeldByForeignOwner);
  });

  it('names the tool it refused', async () => {
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('development');
    const seen = recorder();
    render(boundary(seen, twoClaims(AgentMcpProvider, useMcpTool, seen)));

    await until(() => seen.refused.length > 0, 'the refusal to be reported');
    expect(seen.refused[0]?.name).toBe('contested.name');
    // The declaration site still travels — on the development console, which is where an author with
    // nothing wired reads it. Asserting the console's own text here would be asserting a format; what
    // this case owns is that the event names the tool.
  });
});

describe('a production build', () => {
  it('keeps the application mounted, and the original tool registered', async () => {
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('production');
    const seen = recorder();
    const view = render(boundary(seen, twoClaims(AgentMcpProvider, useMcpTool, seen)));

    await until(() => seen.unexpected.length > 0, 'the conflict to reach the operator');

    // Nothing was torn down: the boundary never fired, and the winner is still registered.
    expect(seen.caught).toEqual([]);
    expect(await registeredNames()).toEqual(['contested.name']);
    view.unmount();
  });

  it('still reports the conflict — what differs is the consequence, not whether anybody is told', async () => {
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('production');
    const seen = recorder();
    render(boundary(seen, twoClaims(AgentMcpProvider, useMcpTool, seen)));

    await until(() => seen.unexpected.length > 0, 'the conflict to reach the operator');
    expect(codeOf(seen.unexpected[0])).toBe(REGISTRATION_REFUSED.nameHeldByThisApplication);
  });

  it('sends it to the operator by a code a receiver can branch on', async () => {
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('production');
    const seen = recorder();
    render(boundary(seen, twoClaims(AgentMcpProvider, useMcpTool, seen)));

    await until(() => seen.unexpected.length > 0, 'the conflict to reach the operator');

    // A contested name and a registry-integrity alarm arrive at one destination and call for different
    // responses. The distinction has to survive on the code alone — reading a message string to decide
    // what happened is how a wording change becomes an outage.
    const code = codeOf(seen.unexpected[0]);
    expect(code).toBeDefined();
    expect(Object.values(REGISTRATION_REFUSED)).toContain(code);
  });

  it('does not name a declaration source, because a minified stack names nothing useful', async () => {
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('production');
    const seen = recorder();
    render(boundary(seen, twoClaims(AgentMcpProvider, useMcpTool, seen)));

    await until(() => seen.unexpected.length > 0, 'the conflict to reach the operator');
    expect(String((seen.unexpected[0] as Error).message)).not.toContain('declared at:');
  });
});

describe('a name held by a script this library does not own', () => {
  // The distinction the ownership record exists to make. An application CANNOT fix this by changing
  // its own code, which is why collapsing it into "duplicate" sends a developer hunting for a second
  // `useMcpTool` call that is not there.

  async function withForeignHolder(mode: 'development' | 'production') {
    const { ensureRegistry } = await import('../../src/webmcp/index.ts');
    const { registry } = await ensureRegistry();
    await registry.registerTool(
      {
        name: 'contested.name',
        description: 'registered by somebody else',
        inputSchema: { type: 'object', properties: {} },
        execute: () => ({ content: [{ type: 'text', text: 'not ours' }] }),
      },
      { signal: new AbortController().signal },
    );
    return libraryBuiltFor(mode);
  }

  it('is reported as foreign in a development build, not as a duplicate', async () => {
    const { AgentMcpProvider, useMcpTool } = await withForeignHolder('development');
    const seen = recorder();
    function Tool(): null {
      useMcpTool({ name: 'contested.name', description: 'ours', handler: () => ({}) });
      return null;
    }
    render(
      boundary(
        seen,
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: neverConnects }}
          server={{ name: 'colliding-page', version: '0.0.0' }}
          onUnexpectedState={(failure) => seen.unexpected.push(failure)}
          onRegistration={(event) => seen.refused.push(event)}
        >
          <Tool />
        </AgentMcpProvider>,
      ),
    );

    await until(() => seen.refused.length > 0, 'the refusal to be reported');
    expect(seen.caught).toEqual([]);
    expect(seen.refused[0]?.code).toBe(REGISTRATION_REFUSED.nameHeldByForeignOwner);
    expect(seen.refused[0]?.code).not.toBe(REGISTRATION_REFUSED.nameHeldByThisApplication);
  });

  it('is reported as foreign in a production build too — the split changes the channel, not the cause', async () => {
    const { AgentMcpProvider, useMcpTool } = await withForeignHolder('production');
    const seen = recorder();
    function Tool(): null {
      useMcpTool({ name: 'contested.name', description: 'ours', handler: () => ({}) });
      return null;
    }
    render(
      boundary(
        seen,
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: neverConnects }}
          server={{ name: 'colliding-page', version: '0.0.0' }}
          onUnexpectedState={(failure) => seen.unexpected.push(failure)}
        >
          <Tool />
        </AgentMcpProvider>,
      ),
    );

    await until(() => seen.unexpected.length > 0, 'the conflict to reach the operator');
    expect(seen.caught).toEqual([]);
    expect(codeOf(seen.unexpected[0])).toBe(REGISTRATION_REFUSED.nameHeldByForeignOwner);
  });
});
