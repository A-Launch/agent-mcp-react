import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

// The page server for the native-registry lane, and the reasons for each of its oddities.
//
// **1. Served over loopback HTTP, never a `data:` URL.** The registry's interface is `[SecureContext]`
//    and a `data:` URL is an opaque origin, so a probe written against one reports `undefined` on
//    every engine under every flag. This repository's first probe was exactly that, concluded that
//    Chromium exposed nothing, and was wrong (docs/conformance.md#what-these-cases-do-not-evidence).
//    `localhost` and `127.0.0.1` are both potentially-trustworthy origins, so both are secure
//    contexts.
//
// **2. TWO origins from ONE server.** `localhost` and `127.0.0.1` resolve to the same listener and are
//    DIFFERENT ORIGINS. That is what makes a cross-origin case possible without a second server or a
//    certificate — the top document is loaded from one, an iframe from the other.
//
// **3. A same-origin frame is always embedded alongside the cross-origin ones.** It is the positive
//    control. Without it, a cross-origin result of "no tools" cannot be told apart from "the fixture is
//    broken" — and that ambiguity is what made the first version of the cross-origin case worthless.
//
// **4. A cross-origin frame needs Permissions Policy delegation.** The registry is a policy-controlled
//    feature whose default allowlist is `'self'`, so an embedded cross-origin document does not get it
//    unless the embedder delegates with `allow`. Frames opt in via `delegatePolicy` below. Getting the
//    feature's NAME wrong delegates nothing and looks exactly like the feature being unimplemented —
//    see `POLICY_FEATURE`.
//
// The lane deliberately does NOT serve the example application here. The subject is the platform, and
// a page carrying this library's provider has the portability shim in it. What the library does toward
// a native registry is a different question, asked against the real application in
// `precedence.spec.ts`.
/**
 * The Permissions Policy feature that gates the registry.
 *
 * **`tools`, and there is NO divergence here** — the draft names it `tools` with a default allowlist of
 * `'self'`, Chromium enforces that name, and `src/webmcp/registry.ts` spells it correctly as
 * `REGISTRY_POLICY_FEATURE`.
 *
 * **It is called out because a wrong guess at this name cost a wrong finding.** The first cross-origin
 * attempt delegated `model-context` — inferred from the host property rather than read from the
 * specification's Permissions Policy section — which delegates nothing. The frames then failed to
 * register, and the result was written up as "Chromium implements neither cross-origin option".
 *
 * The answer was already in this repository's own source, correct, two directories away. A guess that
 * fails CLOSED produces a page that looks like a feature being absent, which is the hardest kind of
 * wrong answer to notice.
 */
export const POLICY_FEATURE = 'tools';

/** Where the lane serves the adopted portability layer's bundled ESM entry point from. */
export const LAYER_PATH = '/adopted-layer.js';

export interface PageServer {
  /** The top document's origin — the one the parent page is loaded from. */
  readonly sameOrigin: string;
  /** A different origin backed by the same listener, for the cross-origin frame. */
  readonly crossOrigin: string;
  close(): Promise<void>;
}

/**
 * A page whose script registers one tool and **reports back how that registration settled**.
 *
 * **The report is the correction that made the cross-origin case mean anything.** Two successive
 * versions of it concluded things about `exposedTo` and `fromOrigins` from the parent's listing alone.
 * Both were wrong, for the same reason: a tool missing from the parent's enumeration has at least four
 * possible causes, and the listing cannot tell them apart —
 *
 *   the frame never loaded                  the fixture is broken
 *   the frame has no registry               Permissions Policy withheld it
 *   registration REJECTED                   Permissions Policy blocked the call
 *   registration succeeded, not exposed     the option under test actually did something
 *
 * Only the last is a finding. The first three are the experiment failing to run, and they present
 * identically. The frame therefore posts its registry's presence and its promise's exact settlement to
 * the parent, and the case asserts on that before it interprets a single listing.
 */
function framePage(name: string, exposedTo: string | null): string {
  const options =
    exposedTo === null
      ? '{ signal: new AbortController().signal }'
      : `{ signal: new AbortController().signal, exposedTo: ${exposedTo} }`;
  return `<!doctype html><title>frame</title><script>
    (async () => {
      const report = {
        name: ${JSON.stringify(name)},
        hasRegistry: typeof document.modelContext,
        settled: 'not attempted',
      };
      try {
        await document.modelContext.registerTool({
          name: ${JSON.stringify(name)},
          description: 'declared by a frame',
          inputSchema: { type: 'object' },
          async execute() { return { content: [{ type: 'text', text: 'ok' }] }; },
        }, ${options});
        report.settled = 'fulfilled';
      } catch (cause) {
        report.settled = 'rejected: ' + cause.name;
      }
      parent.postMessage(report, '*');
    })();
  </script>`;
}

/**
 * Starts the lane's server on an ephemeral port and reports both origins it can be reached at.
 *
 * Routes: `/` is the top document, `/frame?name=…&exposed=…` is a registering frame. The top document
 * is built by the case that needs it, because which frames are embedded IS the experiment.
 */
export async function startPageServer(): Promise<PageServer> {
  // **The adopted layer's ESM entry point — the artifact this library actually imports — bundled.**
  //
  // `installPortabilityLayer()` does `await import('@mcp-b/webmcp-polyfill')`, which resolves through
  // the package's `exports` map to `dist/index.js`. That is the file a conformance claim about "the
  // shim" has to exercise, and getting there needs two things this comment exists to justify:
  //
  // **Why bundled rather than served raw.** The ESM entry is not self-contained: it imports
  // `./schema.js`, which imports the bare specifier `@cfworker/json-schema`. A browser with no build
  // step cannot resolve that, and under pnpm the dependency lives in the content-addressed store
  // rather than in a path a fixture could hardcode. Bundling from the entry point is what every real
  // consumer's bundler does, and it starts from the exact file the library imports.
  //
  // **Why not `dist/index.iife.js`.** The package publishes a prebuilt browser bundle and using it was
  // the first attempt. It is a SEPARATELY PUBLISHED artifact — it happens to implement the same early
  // return today, but a claim about the file this library loads cannot be closed by testing a
  // different file that currently agrees (the conformance rule, docs/design.md#testing-strategy).
  // **`import.meta.resolve`, not `createRequire().resolve`, and the difference is this lane's own
  // theme.** `createRequire` resolves under the `require`/`default` export conditions; the library
  // reaches this package through `await import(...)`, which uses `import`. Today the package maps both
  // to the same file, so either spelling finds it — but a future exports-map split would silently
  // point this case at a file the library never loads, which is exactly the defect that made the IIFE
  // version of this test worthless. Resolving under the condition the library actually uses removes
  // the trap rather than documenting it.
  const layerEntry = fileURLToPath(import.meta.resolve('@mcp-b/webmcp-polyfill'));
  const built = buildSync({
    entryPoints: [layerEntry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  }).outputFiles[0];
  // Checked rather than asserted with `!`: an empty result would otherwise serve `undefined` as
  // JavaScript, and the case would fail with a module syntax error instead of naming the cause.
  if (built === undefined) throw new Error('esbuild produced no output for the adopted layer');
  const bundled = built.text;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://placeholder');
    if (url.pathname === LAYER_PATH) {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(bundled);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    if (url.pathname === '/frame') {
      response.end(
        framePage(url.searchParams.get('name') ?? 'frame.tool', url.searchParams.get('exposed')),
      );
      return;
    }
    // The top document embeds whatever the case asked for, **served rather than injected**.
    // `page.setContent` was tried first and silently defeats the whole experiment: it replaces the
    // document, so the `addInitScript` listener collecting the frames' reports is gone before any
    // frame posts one. The symptom is an empty report list, which reads like "the frames never ran".
    const frames = JSON.parse(url.searchParams.get('frames') ?? '[]') as {
      src: string;
      delegatePolicy?: boolean;
    }[];
    const embeds = frames
      .map(
        ({ src, delegatePolicy }) =>
          `<iframe src="${src}"${delegatePolicy === true ? ` allow="${POLICY_FEATURE} *"` : ''}></iframe>`,
      )
      .join('');
    response.end(`<!doctype html><title>native registry probe</title>${embeds}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    sameOrigin: `http://localhost:${port}`,
    crossOrigin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The URL of a top document embedding the given frames — navigate to it, never inject it. */
export function topDocumentUrl(
  server: PageServer,
  frames: readonly { readonly src: string; readonly delegatePolicy?: boolean }[],
): string {
  return `${server.sameOrigin}/?frames=${encodeURIComponent(JSON.stringify(frames))}`;
}
