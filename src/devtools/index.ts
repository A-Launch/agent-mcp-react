// The in-page development inspector (docs/observing-tool-calls.md#the-inspector). Its own subpath
// export (`@agent-mcp/react/devtools`) so a build that never imports it never contains it.
//
// **Single responsibility: it explains, and it cannot act.** It renders what happened — the connection
// state, the AGENT-VISIBLE tool set (a tool the application has closed is declared and not bridged, so
// it is not listed), and the recent calls with the gate step that decided each one. It may not invoke
// a tool, grant a capability, or register anything: authority only narrows, and nothing here may widen
// what the provider's capabilities admit.
//
// Invariant this directory enforces, and the reason it is enforced by SHAPE rather than by a type: the
// inspector receives DATA and never a handle. It is constructed with a host element and nothing else —
// no runtime, no gateway, no ownership record, no registry — and nothing it exposes returns something
// callable. A `readonly` is a compile-time promise an `as` cast erases; a module that holds a handle it
// promises not to use is the same hazard as a module that decides whether it may run.
//
// **It reads `window.__AGENT_MCP__` and nothing else.** That channel is installed by the provider only
// when an application explicitly enabled it AND the build is a development build, and it carries
// metadata only in every configuration. Reading a global rather than being handed a bus is what lets
// this module stay out of an application's bundle entirely: the provider does not import it, so
// nothing pulls it in but an explicit import of this subpath.
//
// It imports no React: the module rule keeps React in `src/react/` alone, and beyond compliance a panel
// built on the renderer it inspects dies with the tree it is there to diagnose. It attaches nothing on
// import — a surface that appears because something was imported is one whose presence cannot be
// reasoned about from the code that depends on it.

import { createCallLog, type ObservedRecord, RETAINED_CALLS } from './call-log.ts';
import { renderPanel } from './panel.ts';
import { PANEL_STYLES } from './panel-styles.ts';

/** The channel the provider installs on the global. Structural: this module imports no library types. */
interface Channel {
  readonly version: number;
  subscribe(sink: (event: ObservedRecord) => void): () => void;
  /** Fires when the connection state or the bridged tool set moved. Neither produces a call. */
  subscribeSnapshot(sink: () => void): () => void;
  snapshot(): { readonly connection: { status: string }; readonly tools: readonly string[] };
}

/**
 * The handle `createInspector` returns.
 *
 * **Its only method releases it.** There is deliberately nothing here that returns a tool, a handler, a
 * capability or a runtime — "nothing below the provider may widen its authority" made structural. A
 * case reaches for one through every property this exposes and finds nothing, which is a claim a
 * `readonly` could not support.
 */
export interface Inspector {
  dispose(): void;
}

export interface InspectorOptions {
  /** Where to render. The only thing this function accepts, and the only thing it retains. */
  readonly host: Element;
}

/** Reads the channel the provider installs, or nothing when it was never enabled. */
function channel(): Channel | undefined {
  const found = (globalThis as unknown as Record<string, unknown>).__AGENT_MCP__;
  if (found === undefined || found === null) return undefined;
  const candidate = found as Partial<Channel>;
  // Validated rather than cast. The global is a well-known name on a shared page, and something else
  // may own it — refusing an unusable one is better than throwing from inside a render, and a value
  // that cannot be made sense of is never quietly treated as a working channel.
  if (
    typeof candidate.subscribe !== 'function' ||
    typeof candidate.subscribeSnapshot !== 'function' ||
    typeof candidate.snapshot !== 'function'
  ) {
    return undefined;
  }
  return candidate as Channel;
}

/**
 * Mounts the inspector into `host`.
 *
 * Takes a host element and NOTHING else. It is handed no runtime, no gateway, no ownership record and
 * no registry, so there is no configuration in which it could reach one — which is what makes
 * "nothing here may widen the provider's authority" structural rather than a promise a type makes and
 * a cast erases.
 *
 * With no channel installed — a production build, or an application that never enabled it — it renders
 * a line saying so and subscribes to nothing. It does not throw: a development affordance that took a
 * page down when it was not switched on would be worse than the absence it is reporting.
 */
export type { InspectedCall } from './call-log.ts';

/**
 * Attaches the panel's own shadow root to `host` and returns the element to render into.
 *
 * **Isolation in both directions, and both matter.** Nothing the host has written can reach the panel
 * — not a reset, not `div { font-size: 11px }`, not a dark theme the panel knows nothing about — and
 * nothing the panel defines escapes into the host. A developer opens this when the page is already
 * misbehaving, so its legibility must not depend on the page being well.
 *
 * Reuses an existing root rather than attaching a second one, because `attachShadow` throws on a host
 * that already has one and a caller who disposed an inspector and created another on the same element
 * is doing something entirely reasonable.
 */
function shadowMount(host: Element): Element {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (root.querySelector('style') === null) {
    const style = document.createElement('style');
    style.textContent = PANEL_STYLES;
    root.append(style);
  }
  let mount = root.querySelector('.agent-mcp-inspector-mount');
  if (mount === null) {
    mount = document.createElement('div');
    mount.className = 'agent-mcp-inspector-mount';
    root.append(mount);
  }
  return mount;
}

export function createInspector(options: InspectorOptions): Inspector {
  // **Destructured once, so nothing else survives.** Reading `options.host` repeatedly would close
  // over the whole options object, and a caller casting past the type could then smuggle a runtime in
  // beside the host and have this module RETAIN it. The reachability would be invisible to a test
  // that inspects only the returned handle — which is exactly what a review pointed out. Taking the
  // one field means there is no second field to hold.
  const { host } = options;
  const log = createCallLog();
  const found = channel();
  let stopped = false;
  const mount = shadowMount(host);

  const draw = (): void => {
    if (stopped) return;
    const snapshot = found?.snapshot();
    renderPanel(mount, {
      available: found !== undefined,
      // Spread rather than assigned `undefined`: `exactOptionalPropertyTypes` treats an absent property
      // and one explicitly set to `undefined` as different things, which is the point of the flag.
      ...(snapshot === undefined ? {} : { snapshot }),
      calls: log.calls(),
      truncated: log.truncated(),
      retained: RETAINED_CALLS,
    });
  };

  const unsubscribe = found?.subscribe((event) => {
    log.accept(event);
    draw();
  });
  // Redrawn on a snapshot change too. A panel that only redrew on calls would report a healthy page as
  // disconnected until an agent happened to invoke something — a surface presenting its own staleness
  // as fact, which is the shape of defect this whole feature exists to remove.
  const unsubscribeSnapshot = found?.subscribeSnapshot(draw);

  draw();

  return {
    dispose() {
      stopped = true;
      unsubscribe?.();
      unsubscribeSnapshot?.();
      // The MOUNT is emptied, not the host: a shadow root cannot be detached once attached, so
      // clearing the host's light-DOM children would leave the panel on screen while reporting an
      // empty host — a disposal that looks complete and is not. The stylesheet stays, which costs
      // nothing and is what lets a second `createInspector` on the same host reuse this root.
      mount.replaceChildren();
    },
  };
}
