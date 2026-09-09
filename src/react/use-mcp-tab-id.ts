import { pageInstanceId } from '../page-identity.ts';

/**
 * Reports this page instance's identity — how an agent runtime holding several connections says which
 * page it means.
 *
 * **It is metadata, and never a credential.** Holding it grants nothing: no capability, no policy
 * decision and no tool admission consults it, and a connection that presents one is admitted by
 * exactly the capabilities the provider was given — see docs/connecting-to-an-agent.md. It is safe to
 * log, safe to render and safe to put in a URL — which is the point, because that is what an
 * application does with it.
 *
 * **The application attaches it; this library does not.** The intended use is inside the `getUrl`
 * supplier handed to the provider, appended to whatever the application's backend returned. The
 * transport is forbidden to parse or amend a URL, and the supplier's signature must not grow a
 * parameter — a supplier needing an argument from the transport would be a supplier the transport had
 * to understand. So the value is published here and travels the rest of the way through application
 * code.
 *
 * The corollary is a gap worth knowing about rather than discovering: this library **cannot** tell
 * whether an application actually attached it. The URL is opaque by construction, and reading one to
 * check would be the parsing the seam exists to prevent.
 *
 * **Readable during the first render, with no provider above it, and both are deliberate.** An
 * application needs the identity while it is building a connection URL, which can happen during
 * render — so there is no window in which a page instance has no identity, and therefore no absent
 * case for a caller to handle and no placeholder for one to append by mistake. And an identity is a
 * fact about the page rather than about a connection, so it does not wait for a provider, a socket, or
 * anything to be mounted.
 *
 * It never causes a rerender: the value cannot change for the life of the document.
 *
 * **It throws where there is no page instance to identify** — a server render — or where the platform
 * offers no cryptographic source of unique values, which in practice means a page served over plain
 * HTTP from something other than localhost. Neither returns a substitute: two page instances sharing
 * an identity is the failure this exists to prevent, and it fails in the direction that reads as
 * success. A caller that wants to tolerate it catches `PageIdentityError` and decides for itself.
 */
export function useMcpTabId(): string {
  // Not `useState`, `useMemo` or `useRef`. The value is document-scoped and already memoised at its
  // source, so a React-scoped cache would be a second place holding it — and one that a remount would
  // discard and re-derive, which is exactly the per-mount identity this hook must not have.
  return pageInstanceId();
}
