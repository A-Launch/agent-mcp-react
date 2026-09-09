import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_FAILURE } from '../../src/runtime/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  afterMount,
  boundary,
  clearRegistry,
  codeOf,
  enterSecureContext,
  neverConnects,
  recorder,
  registeredNames,
  until,
} from './harness.ts';

// What a provider does with a capability set it cannot use.
//
// **The claim is about ORDER, and order is the only thing worth asserting here.** A provider that
// eventually complained about a typo'd capability, having first resolved the registry, claimed the
// document, registered every tool and opened a socket, would satisfy a case that only checked for the
// complaint — and would have exposed the page under capabilities nobody wrote before anyone objected.
// So every case below asserts an ABSENCE alongside the report: nothing registered, nothing dialed.
//
// The two builds are both here because they behave differently on purpose: development throws to the
// author, production reports to the operator. What they must NOT differ about is whether anything was
// exposed — a gate that exists in development and not in production is the shape of every capability
// defect this feature exists to prevent.

beforeEach(() => {
  enterSecureContext();
  clearRegistry();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  clearRegistry();
});

async function libraryBuiltFor(mode: 'development' | 'production') {
  vi.stubEnv('NODE_ENV', mode);
  vi.resetModules();
  return import('../../src/react/index.ts');
}

/**
 * A page that declares one tool, under whatever capability set a case hands it.
 *
 * `capabilities` is deliberately typed loosely: the whole point of the normalizer is that the value
 * may arrive from JavaScript, from JSON, or through a cast, so a case that could only express a
 * well-typed set could not reach the branch being tested.
 */
function page(
  AgentMcpProvider: typeof import('../../src/react/index.ts').AgentMcpProvider,
  useMcpTool: typeof import('../../src/react/index.ts').useMcpTool,
  capabilities: unknown,
  seen: ReturnType<typeof recorder>,
  dials: Dials = { count: 0 },
): ReactNode {
  function Tool(): null {
    useMcpTool({ name: 'customers.set_filters', description: 'filters', handler: () => ({}) });
    return null;
  }
  return (
    <AgentMcpProvider
      capabilities={capabilities as typeof APPLICATION_ONLY}
      connection={{
        getUrl: () => {
          dials.count += 1;
          return neverConnects();
        },
      }}
      server={{ name: 'typo-page', version: '0.0.0' }}
      onUnexpectedState={(failure) => seen.unexpected.push(failure)}
    >
      <Tool />
    </AgentMcpProvider>
  );
}

/** Whether this library has resolved a tool registry onto the document — monotonic, never undone. */
function registryWasResolved(): boolean {
  return (document as unknown as { modelContext?: unknown }).modelContext !== undefined;
}

/**
 * How many times the provider asked for a connection URL.
 *
 * Counted separately from the operator's alarm destination, and that separation is load-bearing: an
 * earlier version pushed a marker into `unexpected` instead, so a case that legitimately dialed first
 * found the dial marker where it expected the capability report, and read `undefined`.
 */
interface Dials {
  count: number;
}

/** A set with one member nobody has ever heard of — the author believes they granted something. */
const HAS_A_TYPO = {
  application: true,
  dom: { inspect: false, interact: false },
  evalaute: true,
};

describe('a development build handed a capability set it cannot use', () => {
  it('throws to the author', async () => {
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('development');
    const seen = recorder();
    render(boundary(seen, page(AgentMcpProvider, useMcpTool, HAS_A_TYPO, seen)));

    await until(() => seen.caught.length > 0, 'the refusal to reach the error boundary');
    expect(codeOf(seen.caught[0])).toBe(RUNTIME_FAILURE.capabilitiesUnusable);
  });

  it('names the member, so the author can find the typo they actually made', async () => {
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('development');
    const seen = recorder();
    render(boundary(seen, page(AgentMcpProvider, useMcpTool, HAS_A_TYPO, seen)));

    await until(() => seen.caught.length > 0, 'the refusal to reach the error boundary');
    expect((seen.caught[0] as Error).message).toContain('evalaute');
  });

  it('registers nothing and dials nothing', async () => {
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('development');
    const seen = recorder();
    const dials: Dials = { count: 0 };
    render(boundary(seen, page(AgentMcpProvider, useMcpTool, HAS_A_TYPO, seen, dials)));

    await afterMount();
    // **Three assertions, and only the last two are proof.** "No names in the registry" is a state
    // that a provider which registered and then withdrew also reaches, so on its own it is a false
    // green waiting for a slower machine. The other two cannot be undone: a dial that happened stays
    // counted, and a registry, once resolved onto the document, is never removed.
    expect(await registeredNames()).toEqual([]);
    expect(dials.count).toBe(0);
    expect(registryWasResolved()).toBe(false);
  });
});

describe('a production build handed the same set', () => {
  it('does not tear the page down', async () => {
    // A typo in a capability must not white-screen a working application. The page still renders; it
    // simply is not an MCP server.
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('production');
    const seen = recorder();
    render(boundary(seen, page(AgentMcpProvider, useMcpTool, HAS_A_TYPO, seen)));

    await afterMount();
    expect(seen.caught).toEqual([]);
  });

  it('reports it to the operator, with the same cause the author would have seen', async () => {
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('production');
    const seen = recorder();
    render(boundary(seen, page(AgentMcpProvider, useMcpTool, HAS_A_TYPO, seen)));

    await until(() => seen.unexpected.length > 0, 'the report to reach the operator');
    expect(codeOf(seen.unexpected[0])).toBe(RUNTIME_FAILURE.capabilitiesUnusable);
  });

  it('registers nothing and dials nothing either', async () => {
    // **The case that matters most in this file.** Production is where the difference between
    // "complained" and "did not expose the page" is invisible from the outside, and it is the build
    // where an exposure would last.
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('production');
    const seen = recorder();
    const dials: Dials = { count: 0 };
    render(boundary(seen, page(AgentMcpProvider, useMcpTool, HAS_A_TYPO, seen, dials)));

    await afterMount();
    expect(await registeredNames()).toEqual([]);
    expect(dials.count).toBe(0);
    // The same two facts that cannot be undone. Production is where the difference between
    // "complained" and "never exposed the page" is invisible from the outside, and where an exposure
    // would last.
    expect(registryWasResolved()).toBe(false);
  });
});

describe('a provider that was serving and is handed a set it cannot use', () => {
  // **The transition the first version of this file did not cover**, named by an adversarial review:
  // committed-valid → invalid. A provider that checked its capabilities only on the first render would
  // pass every case above and would go on admitting calls under a set that had since become
  // unreadable.
  //
  // **What this file can and cannot say about it.** These two cases assert the page-side facts: the
  // operator is told, and the application's own tools are NOT withdrawn — a capability governs this
  // library's bridge, not the page (docs/explanation-reachability.md). They deliberately do
  // not claim the agent-side outcome, and an earlier version of this file did: it read the document
  // registry, where the tool never went away, and passed against a provider that had destroyed the
  // bridge and lost every tool from the agent's listing. That claim is asserted where an agent can
  // be asked — `tests/transport/react/capability-change.spec.tsx`.

  it('tells the operator, so a page silently refusing everything is not the first symptom', async () => {
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('production');
    const seen = recorder();
    const rendered = render(
      boundary(seen, page(AgentMcpProvider, useMcpTool, APPLICATION_ONLY, seen)),
    );

    await until(
      async () => (await registeredNames()).includes('customers.set_filters'),
      'the tool to be registered while the set is usable',
    );

    rendered.rerender(boundary(seen, page(AgentMcpProvider, useMcpTool, HAS_A_TYPO, seen)));
    await until(
      () => seen.unexpected.some((f) => codeOf(f) === RUNTIME_FAILURE.capabilitiesUnusable),
      'the report to reach the operator',
    );
  });

  it('leaves the application its own tools, because a capability governs the bridge', async () => {
    // The half that would break if "serves nothing" were read as "withdraw everything". Every script
    // in the page — including the application's own code — reaches these through the document's
    // registry, and none of that has anything to do with what an agent may call.
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('production');
    const seen = recorder();
    const rendered = render(
      boundary(seen, page(AgentMcpProvider, useMcpTool, APPLICATION_ONLY, seen)),
    );

    await until(
      async () => (await registeredNames()).includes('customers.set_filters'),
      'the tool to be registered while the set is usable',
    );

    rendered.rerender(boundary(seen, page(AgentMcpProvider, useMcpTool, HAS_A_TYPO, seen)));
    await afterMount();

    expect(await registeredNames()).toContain('customers.set_filters');
  });
});

describe('the same page with a set the provider can use', () => {
  it('registers its tool, which is what makes every absence above meaningful', async () => {
    // **The pairing for this whole file.** Without it, a provider that never registered anything under
    // any capability set would pass every case above — and the suite would be green with the library
    // switched off.
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('development');
    const seen = recorder();
    render(boundary(seen, page(AgentMcpProvider, useMcpTool, APPLICATION_ONLY, seen)));

    await until(
      async () => (await registeredNames()).includes('customers.set_filters'),
      'the tool to be registered under a usable capability set',
    );
    expect(seen.caught).toEqual([]);
  });

  it('registers just the same when the set grants the agent nothing', async () => {
    // A capability is not a withdrawal (docs/explanation-reachability.md).
    // `application: false` refuses the agent's calls
    // and leaves the tool in the document's shared registry, reachable by any script on the page.
    // A provider that expressed denial as "do not register" would pass the file's refusal cases and
    // would have removed the page's own access to its own tools.
    const { AgentMcpProvider, useMcpTool } = await libraryBuiltFor('development');
    const seen = recorder();
    render(
      boundary(
        seen,
        page(
          AgentMcpProvider,
          useMcpTool,
          { application: false, dom: { inspect: false, interact: false }, evaluate: false },
          seen,
        ),
      ),
    );

    await until(
      async () => (await registeredNames()).includes('customers.set_filters'),
      'the tool to be registered under a set that grants nothing',
    );
  });
});
