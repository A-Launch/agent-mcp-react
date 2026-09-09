// The command-line face of the mock agent: `tabs`, `tools` and `call`.
//
// The tool listing is `tools`, not `list`, and the name is load-bearing: `pnpm list` is a built-in
// that pnpm runs INSTEAD of a script of the same name, so `pnpm -C tools/mock-agent list` would print
// the dependency tree and exit 0 while looking exactly like it worked. A script name that a package
// manager shadows is a silent success, which is the failure class this project cares most about.
//
// These are thin HTTP callers against a gateway that is already running, not a second runtime. The
// MCP client lives in the `pnpm dev:agent` process because it acts on a socket that process is
// holding; a CLI that opened its own connection would be a different agent talking to a different
// page state.
//
// There is deliberately no `watch`. Following the tool set as it changes means receiving
// `notifications/tools/list_changed`, and on the current protocol a client receives change
// notifications only over a subscription stream it opens — the exact call for which this project has
// not yet established. Polling `list` on a timer would look like the same command and would report a
// change that had already happened, which is a workaround rather than the mechanism — and the rule
// here is to fix the cause, never to mask it with a poll on a timer.

// Nothing is imported here, so this declares the file a module — top-level `await` needs one.
export {};

const DEFAULT_PORT = 45000;
const port = process.env.AMR_GATEWAY_PORT ?? String(DEFAULT_PORT);
const base = `http://127.0.0.1:${port}`;

const [command, ...rest] = process.argv.slice(2);

function usage(): never {
  console.error(
    [
      'usage:',
      '  tabs                        list connected tabs and whether MCP answered on each',
      '  tools [tab]                 the tools the page currently exposes',
      '  call <name> [json] [tab]    invoke a tool',
      '',
      `talking to ${base} — override with AMR_GATEWAY_PORT`,
    ].join('\n'),
  );
  process.exit(2);
}

/** Prints the body and exits non-zero on any non-2xx, so a failed call fails a script. */
async function show(response: Response): Promise<never> {
  const body: unknown = await response.json().catch(() => ({ error: 'the gateway sent no JSON' }));
  console.log(JSON.stringify(body, null, 2));
  process.exit(response.ok ? 0 : 1);
}

try {
  if (command === 'tabs') {
    await show(await fetch(`${base}/tabs`));
  }

  if (command === 'tools') {
    const tab = rest[0];
    const query = tab === undefined ? '' : `?tab=${encodeURIComponent(tab)}`;
    await show(await fetch(`${base}/tools${query}`));
  }

  if (command === 'call') {
    const [name, rawArguments, tab] = rest;
    if (name === undefined) usage();
    await show(
      await fetch(`${base}/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          arguments: rawArguments === undefined ? {} : JSON.parse(rawArguments),
          ...(tab === undefined ? {} : { tab }),
        }),
      }),
    );
  }

  usage();
} catch (cause) {
  // The overwhelmingly likely cause is that nothing is listening, and saying so beats a stack trace
  // about a refused connection.
  console.error(`could not reach the mock agent at ${base} — is \`pnpm dev:agent\` running?`);
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}
