// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { Component, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTool } from '../../../src/react/index.ts';
import { createAjvValidator } from '../../../src/validation/ajv.ts';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

// The refusal must cost the page nothing that was already working.
//
// A guard that protected the invariant by breaking the running server would trade one broken state
// for another — and the first provider is the one an agent is already connected to.

afterEach(closeAll);

function Tool(): null {
  useMcpTool({
    name: 'first.action',
    description: 'owned by the first provider',
    handler: () => ({ ok: true }),
  });
  return null;
}

class Swallow extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

const sharedValidator = createAjvValidator();

describe('after a second provider is refused', () => {
  it('the first is still serving, and its tools are still callable', async () => {
    const page = await stack(<Tool />);
    await until(
      async () => (await listedNames(page.client)).includes('first.action'),
      'the first provider to register its tool',
    );

    // A second provider mounted into the same document, in its own tree — a micro-frontend, a second
    // bundle, a nested provider somebody added.
    render(
      <Swallow>
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: () => Promise.reject(new Error('the second must never dial')) }}
          server={{ name: 'second-app', version: '0.0.0' }}
          validation={{ validator: sharedValidator }}
          onUnexpectedState={() => undefined}
        >
          <p>second</p>
        </AgentMcpProvider>
      </Swallow>,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await listedNames(page.client)).toEqual(['first.action']);
    const result = await page.client.callTool({ name: 'first.action', arguments: {} });
    expect(result.isError ?? false).toBe(false);
  });
});
