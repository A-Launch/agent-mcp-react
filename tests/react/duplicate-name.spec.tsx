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
    >
      <Tool />
      <Tool />
    </AgentMcpProvider>
  );
}

describe('a development build', () => {
  it('stops the author, through the error boundary rather than a log line', async () => {
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('development');
    const seen = recorder();
    render(boundary(seen, twoClaims(AgentMcpProvider, useMcpTool, seen)));

    await until(() => seen.caught.length > 0, 'the refusal to reach the error boundary');
    expect(seen.caught).toHaveLength(1);
  });

  it('says the application collided with itself, never that a foreign script holds the name', async () => {
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('development');
    const seen = recorder();
    render(boundary(seen, twoClaims(AgentMcpProvider, useMcpTool, seen)));

    await until(() => seen.caught.length > 0, 'the refusal to reach the error boundary');
    // An author told "a foreign script holds this" goes looking outside their own code for a conflict
    // that is not there.
    expect(codeOf(seen.caught[0])).toBe(REGISTRATION_REFUSED.nameHeldByThisApplication);
    expect(codeOf(seen.caught[0])).not.toBe(REGISTRATION_REFUSED.nameHeldByForeignOwner);
  });

  it('names the tool and where the later declaration came from', async () => {
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('development');
    const seen = recorder();
    render(boundary(seen, twoClaims(AgentMcpProvider, useMcpTool, seen)));

    await until(() => seen.caught.length > 0, 'the refusal to reach the error boundary');
    const message = String((seen.caught[0] as Error).message);
    expect(message).toContain('contested.name');
    // Best effort by design: it degrades to no source rather than to a wrong one. Where the environment
    // offers a stack, the refusal points at a declaration instead of at a name.
    expect(message).toContain('declared at:');
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
        >
          <Tool />
        </AgentMcpProvider>,
      ),
    );

    await until(() => seen.caught.length > 0, 'the refusal to reach the error boundary');
    expect(codeOf(seen.caught[0])).toBe(REGISTRATION_REFUSED.nameHeldByForeignOwner);
    expect(codeOf(seen.caught[0])).not.toBe(REGISTRATION_REFUSED.nameHeldByThisApplication);
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
