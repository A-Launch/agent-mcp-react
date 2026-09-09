import {
  admitsSource,
  CATALOG,
  defaultSettingsFor,
  type SettingsByKind,
} from '../catalog/kinds.ts';
import {
  DATA_SOURCES,
  type DataSourceName,
  MAX_PANELS,
  PANEL_KINDS,
  type PanelKind,
} from '../catalog/vocabulary.ts';
import {
  accountsSnapshotVersion,
  resetAccountsForTests,
  resetDealsForTests,
} from '../data/sources.ts';

// The board: the one piece of state the person and the agent both act on.
//
// **Module scope, not React context, and that is a correctness requirement rather than a style call.**
// `board.add_panel`, `board.remove_panel` and `board.reorder` are declared at IMPORT TIME through
// `@agent-mcp/react/actions`, before React mounts. A handler that reached for a context would have no
// component to read it from, and a ref filled in during an effect would leave those tools registered and
// non-functional until something rendered — a tool that lies about being ready. React subscribes to this
// store; it does not own it. `examples/customer-dashboard` creates its router at module scope for
// exactly the same reason.
//
// **Every mutation below is called by both callers.** The toolbar and the tools call the SAME function,
// never an equivalent second path. That is what makes "a board built half by hand and half by chat is
// one board" true in the data rather than remembered as a rule.
//
// What this module owns: the panel list, the id counter and the transitions. It owns no schema, no
// registration, no rendering and no knowledge that an agent exists.

/** One panel on the board. A discriminated union, so a switch over `kind` types its settings. */
export type Panel = {
  [K in PanelKind]: {
    readonly id: string;
    readonly kind: K;
    readonly source: DataSourceName;
    readonly settings: SettingsByKind[K];
  };
}[PanelKind];

export interface BoardSnapshot {
  readonly panels: readonly Panel[];
  /** Bumped by any change, including one to the account list a form appended to. */
  readonly version: number;
}

/** What the agent asks for when it creates panels. Note the absence of an id and of settings. */
export interface PanelRequest {
  readonly kind: PanelKind;
  readonly source: DataSourceName;
}

let panels: readonly Panel[] = [];
/**
 * The id counter.
 *
 * **One counter for the whole board, never reset by a removal, and never derived from position.** Three
 * properties are load-bearing at once. Unique, because two panels answering to one identifier is a wrong
 * answer that looks entirely normal — the same shape as the hand-written tab id this repository broke on.
 * Legible, because a person watching the chat's tool log has to be able to point at the panel
 * `panel.table-1.set_sort` acted on. And independent of position, which is the one a reasonable
 * implementation gets wrong: an id derived from the index would rename every tool below a moved panel on
 * every reorder, turning one reorder into a mass withdraw-and-register cycle and a notification storm.
 */
let nextId = 1;
let localVersion = 0;

const listeners = new Set<() => void>();

let snapshot: BoardSnapshot = { panels, version: 0 };

function publish(): void {
  localVersion += 1;
  // The account list is part of what the board renders, so its version participates in the snapshot
  // identity: a form submission changes no panel and must still repaint every table bound to accounts.
  snapshot = { panels, version: localVersion + accountsSnapshotVersion() };
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between changes, so `useSyncExternalStore` does not re-render on every read. */
export function getSnapshot(): BoardSnapshot {
  return snapshot;
}

export function currentPanels(): readonly Panel[] {
  return panels;
}

export function findPanel(id: string): Panel | undefined {
  return panels.find((panel) => panel.id === id);
}

/** The ids currently on the board, for a refusal that names what the caller could have said. */
function panelIds(): string {
  return panels.length === 0 ? '(the board is empty)' : panels.map((panel) => panel.id).join(', ');
}

function refuseUnknownPanel(id: string): never {
  throw new Error(`no panel with id "${id}" is on the board — the ids on it are: ${panelIds()}`);
}

/**
 * Creates one or more panels, and either all of them appear or none does.
 *
 * **The batch is what makes this atomic.** One chat request becomes one call, so a second entry naming a
 * source that does not exist cannot leave the first entry's panel standing on a board nobody asked for.
 * Every entry is validated before any is applied.
 *
 * Refuses, naming the permitted set in each case: an unknown kind, an unknown source, a kind/source pair
 * the catalog does not admit (both halves individually legal, the combination not), and a batch that
 * would take the board past its ceiling. **No placeholder panel is ever created** — a refusal leaves the
 * board exactly as it was.
 */
export function addPanels(requests: readonly PanelRequest[], position?: number): readonly Panel[] {
  if (requests.length === 0) throw new Error('name at least one panel to add');

  if (panels.length + requests.length > MAX_PANELS) {
    throw new Error(
      `a board holds at most ${String(MAX_PANELS)} panels; it has ${String(panels.length)} and ` +
        `this would add ${String(requests.length)}`,
    );
  }

  // Validate the WHOLE batch first. Applying as we go would make a refusal depend on where in the list
  // it appeared, which is the partial-application failure the batch exists to prevent.
  for (const request of requests) {
    if (!PANEL_KINDS.includes(request.kind)) {
      throw new Error(
        `"${request.kind}" is not a panel kind — this board offers: ${PANEL_KINDS.join(', ')}`,
      );
    }
    if (!DATA_SOURCES.includes(request.source)) {
      throw new Error(
        `"${request.source}" is not a data source — this board offers: ${DATA_SOURCES.join(', ')}`,
      );
    }
    if (!admitsSource(request.kind, request.source)) {
      throw new Error(
        `a ${request.kind} panel cannot be bound to "${request.source}" — that kind accepts: ` +
          CATALOG[request.kind].sources.join(', '),
      );
    }
  }

  const created = requests.map((request) => {
    const id = `${request.kind}-${String(nextId)}`;
    nextId += 1;
    return {
      id,
      kind: request.kind,
      source: request.source,
      settings: defaultSettingsFor(request.kind, request.source),
    } as Panel;
  });

  const at = position === undefined ? panels.length : clamp(position, 0, panels.length);
  panels = [...panels.slice(0, at), ...created, ...panels.slice(at)];
  publish();
  return created;
}

export function removePanel(id: string): Panel {
  const panel = findPanel(id);
  if (panel === undefined) refuseUnknownPanel(id);
  panels = panels.filter((candidate) => candidate.id !== id);
  publish();
  return panel;
}

/**
 * Moves a panel to a new index.
 *
 * **This changes no panel's identity and therefore registers and withdraws nothing.** The tool set is
 * unchanged afterwards and no change notification fires — which is only true because ids come from a
 * counter rather than from position, and because the rendered list is keyed by id rather than by index.
 * Either one done the other way turns this into a mass withdraw-and-register cycle.
 */
export function reorderPanel(id: string, position: number): readonly string[] {
  const from = panels.findIndex((panel) => panel.id === id);
  if (from === -1) refuseUnknownPanel(id);

  const moving = panels[from] as Panel;
  const without = panels.filter((_, index) => index !== from);
  const at = clamp(position, 0, without.length);
  panels = [...without.slice(0, at), moving, ...without.slice(at)];
  publish();
  return panels.map((panel) => panel.id);
}

/**
 * Replaces one panel's settings.
 *
 * Called by a panel's own tool and by its own controls. **It must not affect the tool descriptor**: a
 * descriptor that moved with a setting would produce a withdraw-and-register cycle on every change,
 * which an agent observes as a tool-list-change storm and a window in which the tool does not exist.
 */
export function updateSettings<K extends PanelKind>(
  id: string,
  settings: SettingsByKind[K],
): Panel {
  const panel = findPanel(id);
  if (panel === undefined) refuseUnknownPanel(id);
  const updated = { ...panel, settings } as Panel;
  panels = panels.map((candidate) => (candidate.id === id ? updated : candidate));
  publish();
  return updated;
}

/** Re-publishes without changing the panel list, so a data-only change repaints. */
export function notifyDataChanged(): void {
  publish();
}

/**
 * Empties the board and restores the seed data.
 *
 * For tests only. Module state outlives a component tree, so without this a case would inherit whatever
 * panels the previous one created — and the id counter is deliberately NOT reset, because a test that
 * depended on ids restarting at 1 would be depending on the one property this store does not promise.
 */
export function resetBoardForTests(): void {
  panels = [];
  // **Every mutable collection, not just the one this file remembers.** A case that advanced a deal
  // would otherwise leave it advanced for the next file, and a suite whose data depends on execution
  // order passes until someone runs one case on its own.
  resetAccountsForTests();
  resetDealsForTests();
  publish();
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(Math.trunc(value), low), high);
}
