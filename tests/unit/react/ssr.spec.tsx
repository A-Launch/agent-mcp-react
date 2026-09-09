import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';

// Server rendering: a normal path, not a failure. The provider resolves the registry in an effect and
// never at module scope (`docs/design.md#the-provider`).
//
// This case runs in the `node` environment with no document at all, which is the point — every other
// React case in this repository runs against jsdom and therefore cannot tell whether the provider
// depends on one. What it holds: importing the package touches no document, and rendering the provider
// on a server produces markup rather than a socket, a registration or a crash.

describe('the package on a server', () => {
  it('imports without touching a document, a window, or a socket', async () => {
    // Imported inside the case deliberately: the assertion is about what module evaluation does, and
    // a file-scope import would have already done it before the case ran. This is the one place that
    // trade-off goes the other way (the convention exists to keep heavy imports out of a timeout).
    //
    // **`window` and `WebSocket` are trapped HERE and not in the render case below, and the distinction
    // was found by a break-it that failed to go red.** The render case installs its traps inside itself
    // — by which point this case has already imported the module, and Vitest caches it — so a
    // module-scope `window` read happens before any trap exists and slips through. Module evaluation
    // has exactly one case that owns it, and that is this one.
    expect(typeof document).toBe('undefined');

    const constructed: string[] = [];
    const scope = globalThis as Record<string, unknown>;
    scope.WebSocket = class {
      constructor(url: string) {
        constructed.push(url);
      }
    };
    Object.defineProperty(scope, 'window', {
      configurable: true,
      get() {
        throw new Error('importing this package must never reach for window');
      },
    });

    let module: typeof import('../../../src/index.ts');
    try {
      module = await import('../../../src/index.ts');
    } finally {
      Reflect.deleteProperty(scope, 'window');
      Reflect.deleteProperty(scope, 'WebSocket');
    }

    expect(typeof document).toBe('undefined');
    expect(constructed, 'importing the package opened a socket').toEqual([]);
    expect(typeof module.AgentMcpProvider).toBe('function');
  });

  it('writes nothing to the console — the layout effect raises no server-rendering warning', async () => {
    // The hook updates its definition ref in a layout effect, which is the one mechanism that is
    // current to a caller in the task after a commit. Layout effects have historically warned during
    // server rendering, and the usual answer is an isomorphic-effect shim — a second owner of "are we
    // on a server?", a question the provider's design already answers by effects not running at all.
    //
    // Measured instead: neither server renderer says anything. This case is what keeps that true, so
    // the shim stays absent for a reason rather than by luck.
    const { AgentMcpProvider } = await import('../../../src/index.ts');
    const messages: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => messages.push(parts.map(String).join(' '));

    try {
      renderToStaticMarkup(
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: () => Promise.reject(new Error('a server must never dial')) }}
          server={{ name: 'server-rendered', version: '0.0.0' }}
          onUnexpectedState={() => undefined}
        >
          <p>application</p>
        </AgentMcpProvider>,
      );
    } finally {
      console.error = original;
    }

    expect(messages).toEqual([]);
  });

  it('renders its children, opens nothing and throws nothing', async () => {
    const { AgentMcpProvider } = await import('../../../src/index.ts');

    const markup = renderToStaticMarkup(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => Promise.reject(new Error('a server must never dial')) }}
        server={{ name: 'server-rendered', version: '0.0.0' }}
        onUnexpectedState={() => {
          throw new Error('a server render must raise no alarm');
        }}
      >
        <p>application</p>
      </AgentMcpProvider>,
    );

    // Effects do not run on a server, so the provider is inert by construction rather than by a check
    // it performs. The case exists because that is easy to break: a resolution moved to module scope,
    // or to render, would make this throw.
    expect(markup).toBe('<p>application</p>');
  });

  it('opens no socket and reaches for no window, asserted rather than inferred', async () => {
    // **A server render must not crash, must not open a socket and must not read `window` — and the
    // case above only evidenced the first of the three.**
    // "Renders markup" shows the render did not crash; it does not show that no socket was
    // constructed, and it does not show that `window` was never read. Both were true by construction —
    // and a requirement that holds by construction is exactly the kind that stops holding when
    // somebody moves one line, with nothing to notice.
    //
    // Both are instrumented here rather than reasoned about: a global `WebSocket` is installed that
    // records any construction, and a `window` is installed that throws if anything touches it. A
    // server has neither, so installing them cannot mask a real dependency — it can only catch one.
    const { AgentMcpProvider } = await import('../../../src/index.ts');

    const constructed: string[] = [];
    const scope = globalThis as Record<string, unknown>;
    scope.WebSocket = class {
      constructor(url: string) {
        constructed.push(url);
      }
    };
    Object.defineProperty(scope, 'window', {
      configurable: true,
      get() {
        throw new Error('a server render must never reach for window');
      },
    });

    try {
      const markup = renderToStaticMarkup(
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: () => Promise.reject(new Error('a server must never dial')) }}
          server={{ name: 'server-rendered', version: '0.0.0' }}
          onUnexpectedState={() => {
            throw new Error('a server render must raise no alarm');
          }}
        >
          <p>application</p>
        </AgentMcpProvider>,
      );
      expect(markup).toBe('<p>application</p>');
    } finally {
      Reflect.deleteProperty(scope, 'window');
      Reflect.deleteProperty(scope, 'WebSocket');
    }

    expect(constructed, `a server render opened ${constructed.length} socket(s)`).toEqual([]);
  });
});
