import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The example's dev server. Nothing here is part of the library — it exists so an operator can open a
// real browser at the port the `:450xx` block reserves and watch an agent change what is on screen.
//
// `strictPort` is deliberate. A dev server that silently moved to :45011 when :45010 was taken would
// leave the operator looking at a page the documented commands do not describe, and the mock agent's
// logs would name a tab nobody could find.
/**
 * Serves the page under a real Content-Security-Policy when the URL asks for one.
 *
 * **This exists because a CSP cannot be faked from the test side, and that was measured.** The first
 * attempt at it left `MCP_RUNTIME_EVALUATE_FORBIDDEN` unverified and recorded as INCONCLUSIVE: a probe
 * page whose policy omitted `unsafe-eval` still constructed a function, because the tooling evaluates
 * in a context that does not honour the page's CSP. Intercepting the response and rewriting its
 * headers does not work either — measured here: the header arrives and the policy is not enforced.
 *
 * The only faithful instrument is a real server sending a real header, which is what this is. It is
 * dev-server configuration and reaches no shipped code: the application bundle is identical either
 * way, and only the response header differs.
 *
 * `?csp=strict` omits `unsafe-eval`, which is the ordinary posture of a security-conscious
 * application — and the one under which `runtime.evaluate` must refuse by NAME rather than fail as
 * though the expression were at fault.
 */
function cspProbeHeaders() {
  return {
    name: 'amr-csp-probe',
    configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
      server.middlewares.use(
        (
          request: { url?: string },
          response: { setHeader: (name: string, value: string) => void },
          next: () => void,
        ) => {
          if (request.url?.includes('csp=strict') === true) {
            // No `unsafe-eval`. `unsafe-inline` is present because the dev server injects inline
            // module preload scripts; without it the page would not load at all and the case would be
            // testing a blank document rather than a policy.
            response.setHeader(
              'Content-Security-Policy',
              "default-src 'self' ws: http: https: data: blob:; script-src 'self' 'unsafe-inline'",
            );
          }
          next();
        },
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), cspProbeHeaders()],
  // Vite exposes only prefixed variables to the browser, and its default prefix is `VITE_`. This
  // page's variables are named `AMR_` in `.env.example`, so without this line every one of them is
  // `undefined` at runtime — which is precisely what had happened: four documented knobs that read
  // as configuration and changed nothing.
  envPrefix: 'AMR_',
  server: {
    port: 45010,
    strictPort: true,
  },
});
