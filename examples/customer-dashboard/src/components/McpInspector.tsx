import { createInspector } from '@agent-mcp/react/devtools';
import { useEffect, useRef, useState } from 'react';

// Mounts the library's development inspector into this page, as developer chrome rather than as part
// of the product.
//
// **The library's panel is plain DOM, not React**, which is why the mounting below is four lines of
// plumbing rather than a rendering. That is deliberate on the library's side: a panel built on the
// renderer it inspects dies with the tree it exists to diagnose, and a developer opens it precisely
// when that tree is misbehaving.
//
// It is handed a host element and nothing else. There is no prop through which a runtime, a registry
// or a tool handler could reach it, which is what makes "observational only" a property of its shape
// rather than a promise in its documentation. The library owns what the panel LOOKS like — it renders
// into its own shadow root with its own stylesheet — and this file owns only where it SITS, which is
// the one thing the library cannot know.
//
// **Docked rather than placed in the document flow, and that is a correction.** This used to render
// as an ordinary block between the header and the application, which put roughly 300px of developer
// output above the product on every load and an entire screenful above it on a phone. A diagnostic
// surface that pushes the thing it diagnoses below the fold has made the page worse in exactly the
// way it exists to prevent.
export function McpInspector(): React.ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const inspector = createInspector({ host: element });
    return () => inspector.dispose();
  }, []);

  return (
    <aside className="mcp-dock" aria-label="MCP inspector">
      <button
        type="button"
        className="mcp-dock-toggle"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-controls="mcp-dock-panel"
      >
        {/* Names the CONTROL, not the panel. The panel carries its own "MCP Agent" title inside the
            shadow root, and repeating it out here would be two labels for one thing. */}
        <span className="mcp-dock-label">Inspector</span>
        <span aria-hidden="true">{open ? '▾' : '▴'}</span>
      </button>
      {/*
        Hidden with CSS rather than unmounted. Unmounting the host would dispose the inspector and
        construct a new one on every toggle, which discards the call log it exists to show — collapsing
        a panel is not the same as throwing away what it recorded.
      */}
      <div
        id="mcp-dock-panel"
        className="mcp-inspector-host"
        hidden={!open}
        ref={host}
        data-testid="mcp-inspector"
      />
    </aside>
  );
}
