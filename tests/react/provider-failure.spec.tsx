import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider } from '../../src/react/index.ts';
import { REGISTRY_UNAVAILABLE } from '../../src/webmcp/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  afterMount,
  boundary,
  clearRegistry,
  codeOf,
  enterSecureContext,
  neverConnects,
  recorder,
} from './harness.ts';

// The loud channel, and the measurement that shaped it.
//
// Every step of the provider's mount is asynchronous, and a `throw` inside asynchronous work reaches
// no error boundary — it becomes a rejected promise nobody is holding. So the provider captures the
// failure and re-throws it during the next render, which is the only path that reaches a boundary.
// These cases hold that path: delete the re-throw and the page goes on looking normal while it is not
// an MCP server — precisely the hidden unknown the fail-loud rule forbids.

beforeEach(clearRegistry);
afterEach(clearRegistry);

describe('a document whose registry cannot be made available', () => {
  it('throws to the nearest error boundary, naming the cause', async () => {
    // An insecure origin: the registry attribute is `[SecureContext]`, so no implementation is present
    // and the boundary refuses to install a stand-in that exists nowhere else.
    Object.defineProperty(globalThis, 'isSecureContext', {
      value: false,
      configurable: true,
      writable: true,
    });
    const seen = recorder();

    render(
      boundary(
        seen,
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: neverConnects }}
          server={{ name: 'insecure-page', version: '0.0.0' }}
          onUnexpectedState={() => undefined}
        >
          <p>children</p>
        </AgentMcpProvider>,
      ),
    );

    await afterMount();

    expect(seen.caught).toHaveLength(1);
    expect(codeOf(seen.caught[0])).toBe(REGISTRY_UNAVAILABLE.insecureContext);
  });

  it('does not report the failure through the unexpected-state destination', async () => {
    // Two channels, and they are not interchangeable. A setup failure is the application's to handle
    // and must be unignorable; the unexpected-state destination is an operator's alarm about a broken
    // invariant while serving. Sending a setup failure there would make it loggable-and-continue.
    Object.defineProperty(globalThis, 'isSecureContext', {
      value: false,
      configurable: true,
      writable: true,
    });
    const seen = recorder();

    render(
      boundary(
        seen,
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: neverConnects }}
          server={{ name: 'insecure-page', version: '0.0.0' }}
          onUnexpectedState={(failure) => seen.unexpected.push(failure)}
        >
          <p>children</p>
        </AgentMcpProvider>,
      ),
    );

    await afterMount();

    expect(seen.unexpected).toEqual([]);
    expect(seen.caught).toHaveLength(1);
  });

  it('renders children up to the moment it fails, rather than blocking on readiness', async () => {
    // The provider is not a gate in front of an application. A page renders; it either becomes an MCP
    // server or it says loudly that it could not.
    enterSecureContext();
    const seen = recorder();

    const view = render(
      boundary(
        seen,
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: neverConnects }}
          server={{ name: 'slow-page', version: '0.0.0' }}
          onUnexpectedState={() => undefined}
        >
          <p data-testid="content">children</p>
        </AgentMcpProvider>,
      ),
    );

    expect(view.getByTestId('content').textContent).toBe('children');
    expect(seen.caught).toEqual([]);
  });
});
