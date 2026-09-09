// An external embedder: consumes ONLY the package's public entry points, exactly as the
// documentation instructs. No deep imports into src/, no workspace linkage.
import {
  AgentMcpProvider,
  CONFIRMATION,
  useMcpCapabilities,
  useMcpConnection,
  useMcpState,
  useMcpTabId,
  useMcpTool,
} from 'agent-mcp-react';
import { registerMcpTool } from 'agent-mcp-react/actions';
import { createAjvValidator } from 'agent-mcp-react/validation';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { surface } from './surface';

// Declared at module scope, before React mounts — the shell-owned case from the docs.
registerMcpTool({
  name: 'shell.ping',
  description: 'Answers with a fixed string, to prove a module-scope declaration works.',
  handler: () => ({ pong: true }),
});

function Counter() {
  const [count, setCount] = useState(0);

  useMcpTool({
    name: 'counter.increment',
    title: 'Increment the counter',
    description: 'Adds the given amount to the counter shown on the page.',
    inputSchema: {
      type: 'object',
      properties: { by: { type: 'number', description: 'How much to add.' } },
      required: ['by'],
      additionalProperties: false,
    },
    handler: (input) => {
      const by = input.by as number;
      setCount((previous) => previous + by);
      return { added: by };
    },
  });

  useMcpState({
    name: 'counter',
    description: 'The current counter value.',
    schema: { type: 'object', properties: { count: { type: 'number' } } },
    getState: () => ({ count }),
  });

  const capabilities = useMcpCapabilities();
  const connection = useMcpConnection();
  const tabId = useMcpTabId();

  return (
    <main>
      <p>count: {count}</p>
      <p>status: {connection.status}</p>
      <p>application reachable: {String(capabilities.application === true)}</p>
      <p>tab: {tabId}</p>
    </main>
  );
}

// Force every subpath into the graph so the BUNDLER resolves them, not just tsc.
console.log(Object.keys(surface).length);

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <AgentMcpProvider
      connection={{ getUrl: async () => 'ws://localhost:45000/socket?ticket=dev' }}
      server={{ name: 'external-consumer', version: '0.0.0' }}
      capabilities={{
        application: true,
        dom: { inspect: false, interact: false },
        evaluate: false,
      }}
      onUnexpectedState={(failure) => console.error('[mcp]', failure)}
      validation={{ validator: createAjvValidator() }}
      confirmation={{
        resolver: (request) =>
          window.confirm(`Allow ${request.tool}?`) ? CONFIRMATION.approved : CONFIRMATION.refused,
      }}
    >
      <Counter />
    </AgentMcpProvider>
  </StrictMode>,
);
