import { startMockAgent } from './runtime.ts';

// The `pnpm dev:agent` entry point. Starts the mock agent runtime on the port from the `:450xx` block
// and prints what an operator needs: where to fetch a ticket, and every connection, handshake and
// refusal as it happens.
//
// Refusals are logged with their cause rather than counted, because "nothing connects" is the most
// common local failure and the cause is the whole diagnosis — a spent ticket points at a page that
// reloaded, an unknown one at a page dialling a different gateway.

const DEFAULT_PORT = 45000;

const configured = process.env.AMR_GATEWAY_PORT;
const port = configured === undefined ? DEFAULT_PORT : Number.parseInt(configured, 10);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  // A malformed port is a configuration error, not a reason to fall back to a default. Falling back
  // would start a gateway on a port the operator did not ask for, and the page would fail to connect
  // with no indication why. An unexpected state fails loud; a convenience default hides it.
  console.error(`AMR_GATEWAY_PORT is not a valid port: ${String(configured)}`);
  process.exit(1);
}

const agent = await startMockAgent({ port, onEvent: (line) => console.log(line) });

console.log(`mock agent gateway   ${agent.gateway.wsUrl}`);
console.log(`ticket endpoint      ${agent.gateway.httpUrl}/ticket`);
console.log(`health               ${agent.gateway.httpUrl}/health`);
console.log(`control              ${agent.gateway.httpUrl}/tabs · /tools · /call`);
console.log(`chat                 ${agent.gateway.httpUrl}/agent · /chat`);

// Printed at startup rather than discovered on the first message: "the chat does not answer" is the
// most expensive way to learn that a key is missing, and this is the cheapest.
console.log(
  agent.model.available
    ? `model                ${agent.model.name}`
    : `model                none — ${agent.model.reason ?? 'not configured'}`,
);

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal} — closing gateway`);
  await agent.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
