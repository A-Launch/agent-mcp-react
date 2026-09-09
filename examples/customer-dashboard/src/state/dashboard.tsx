import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ACCOUNTS, type Account } from '../domain/accounts.ts';
import {
  type Actor,
  type Health,
  LABEL,
  SORT_DIRECTION,
  type SortField,
} from '../domain/vocabulary.ts';
import {
  DEFAULT_SORT,
  type Filters,
  NO_FILTERS,
  type Sort,
  selectRows,
  summarize,
  type Totals,
} from './filters.ts';

// The dashboard's single owner of state, and of every transition that changes it.
//
// **This is the file the whole demonstration turns on.** There is exactly one function per thing the
// application can do, and both callers reach it: the controls call it from an event handler, the MCP
// tools call it from a tool handler. Neither has a route the other lacks — no agent-only mutation, no
// tool that pokes at state the UI cannot reach.
//
// The `actor` argument is what makes that checkable instead of merely claimed. It records who caused
// a transition and changes nothing about what the transition does; the activity log prints it, so a
// person watching the page can see an agent's edit land in the same list as their own.
//
// What this module does NOT own: registration. Not one line here knows the library exists. The tools
// live in the components that own each feature, which is what makes the tool set change when the
// account drawer opens.

/** One entry in the activity log: what changed, and who changed it. */
export interface Activity {
  readonly id: number;
  readonly at: number;
  readonly actor: Actor;
  readonly summary: string;
}

/** A named filter-and-sort combination a person or an agent stored for later. */
export interface SavedView {
  readonly name: string;
  readonly filters: Filters;
  readonly sort: Sort;
}

/** The edits layered over the fixture. Kept separate so the loaded data stays comparable. */
interface Overrides {
  readonly health: Readonly<Record<string, Health>>;
  readonly notes: Readonly<Record<string, readonly string[]>>;
}

export interface Dashboard {
  readonly filters: Filters;
  readonly sort: Sort;
  readonly rows: readonly Account[];
  readonly totals: Totals;
  readonly selected: Account | undefined;
  readonly views: readonly SavedView[];
  readonly activity: readonly Activity[];
  notesFor(id: string): readonly string[];
  /**
   * This dashboard as it is NOW, rather than as it was when the caller's closure was created.
   *
   * For a tool handler that has just changed something and awaited `context.afterRender()`. The value
   * a handler closes over describes the render it was created in, so reading `totals` off it after the
   * commit still reports the previous numbers — the mistake this exists to make unnecessary.
   *
   * It replaced a `countWith(filters)` that recomputed what the table was about to show. That was a
   * second implementation of the selection the render already performs, kept in step by hand and
   * confidently wrong the first time the two disagreed. Reading what actually rendered has one owner.
   */
  current(): Dashboard;

  /** Merges a partial filter set over the current one. The only way filters ever change. */
  setFilters(patch: Partial<Filters>, actor: Actor): void;
  clearFilters(actor: Actor): void;
  setSort(sort: Sort, actor: Actor): void;
  /** Toggles a column: same field flips direction, a new field starts descending. */
  toggleSort(field: SortField, actor: Actor): void;
  /** Opens the detail drawer for one account. Throws when no such account exists. */
  openAccount(id: string, actor: Actor): Account;
  closeAccount(actor: Actor): void;
  setHealth(id: string, health: Health, actor: Actor): Account;
  addNote(id: string, note: string, actor: Actor): number;
  saveView(name: string, actor: Actor): SavedView;
  applyView(name: string, actor: Actor): SavedView;
  /**
   * Writes one line into the activity feed without changing anything else.
   *
   * For a long-running tool that wants its progress and its ENDING visible on the page. Cancellation
   * is otherwise invisible from a browser window — the agent's client stops listening and the result
   * is discarded, so a person watching would see a call simply stop existing.
   */
  noteActivity(entry: string, actor: Actor): void;
}

const DashboardContext = createContext<Dashboard | undefined>(undefined);

/** How many activity entries are kept. Enough to see a whole agent turn without unbounded growth. */
const ACTIVITY_LIMIT = 40;

export function DashboardProvider({ children }: { children: ReactNode }): ReactNode {
  const [filters, setFiltersState] = useState<Filters>(NO_FILTERS);
  const [sort, setSortState] = useState<Sort>(DEFAULT_SORT);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [overrides, setOverrides] = useState<Overrides>({ health: {}, notes: {} });
  const [views, setViews] = useState<readonly SavedView[]>([]);
  const [activity, setActivity] = useState<readonly Activity[]>([]);

  const record = useCallback((actor: Actor, summary: string): void => {
    setActivity((entries) => {
      const next: Activity = { id: (entries[0]?.id ?? 0) + 1, at: Date.now(), actor, summary };
      return [next, ...entries].slice(0, ACTIVITY_LIMIT);
    });
  }, []);

  // The fixture with its edits applied. Recomputed only when an edit lands, not on every render.
  const accounts = useMemo<readonly Account[]>(
    () =>
      ACCOUNTS.map((account) =>
        overrides.health[account.id] === undefined
          ? account
          : { ...account, health: overrides.health[account.id] as Health },
      ),
    [overrides.health],
  );

  const rows = useMemo(() => selectRows(accounts, filters, sort), [accounts, filters, sort]);
  const totals = useMemo(() => summarize(rows, accounts.length), [rows, accounts.length]);
  const selected = useMemo(
    () => (selectedId === undefined ? undefined : accounts.find((row) => row.id === selectedId)),
    [accounts, selectedId],
  );

  const find = useCallback(
    (id: string): Account => {
      const account = accounts.find((row) => row.id === id || row.name === id);
      // Named refusal rather than a silent no-op: a tool told to open an account that does not exist
      // must tell the agent so, or the agent proceeds believing a drawer it cannot see is open.
      if (account === undefined) throw new Error(`no account matches "${id}"`);
      return account;
    },
    [accounts],
  );

  // Holds whatever the most recent render produced, so `current()` can hand it back. Written during
  // render rather than in an effect: a handler that awaits `afterRender()` resumes after the commit,
  // and the value it must see is the one that commit rendered.
  const latest = useRef<Dashboard>(undefined as unknown as Dashboard);

  const dashboard = useMemo<Dashboard>(() => {
    const describeFilters = (patch: Partial<Filters>): string =>
      Object.entries(patch)
        .map(
          ([key, value]) =>
            `${key}=${Array.isArray(value) ? value.join('|') || '∅' : String(value)}`,
        )
        .join(' ');

    return {
      filters,
      sort,
      rows,
      totals,
      selected,
      views,
      activity,

      notesFor: (id) => overrides.notes[id] ?? [],

      current: () => latest.current,

      noteActivity: (entry, actor) => record(actor, entry),

      setFilters(patch, actor) {
        setFiltersState((current) => ({ ...current, ...patch }));
        record(actor, `filters · ${describeFilters(patch) || 'no change'}`);
      },

      clearFilters(actor) {
        setFiltersState(NO_FILTERS);
        record(actor, 'filters · cleared');
      },

      setSort(next, actor) {
        setSortState(next);
        record(actor, `sort · ${LABEL[next.field]} ${next.direction}`);
      },

      toggleSort(field, actor) {
        // Computed from the rendered sort rather than inside an updater. A `setState` updater may be
        // invoked more than once — strict mode does it deliberately — and logging from inside one
        // would write a duplicate activity entry for a single click.
        const next: Sort =
          sort.field === field
            ? {
                field,
                direction:
                  sort.direction === SORT_DIRECTION.asc ? SORT_DIRECTION.desc : SORT_DIRECTION.asc,
              }
            : { field, direction: SORT_DIRECTION.desc };
        setSortState(next);
        record(actor, `sort · ${LABEL[next.field]} ${next.direction}`);
      },

      openAccount(id, actor) {
        const account = find(id);
        setSelectedId(account.id);
        record(actor, `opened · ${account.name}`);
        return account;
      },

      closeAccount(actor) {
        setSelectedId(undefined);
        record(actor, 'closed the account drawer');
      },

      setHealth(id, health, actor) {
        const account = find(id);
        setOverrides((current) => ({
          ...current,
          health: { ...current.health, [account.id]: health },
        }));
        record(actor, `health · ${account.name} → ${LABEL[health]}`);
        return { ...account, health };
      },

      addNote(id, note, actor) {
        const account = find(id);
        const text = note.trim();
        if (text === '') throw new Error('a note cannot be empty');
        setOverrides((current) => {
          const existing = current.notes[account.id] ?? [];
          return { ...current, notes: { ...current.notes, [account.id]: [...existing, text] } };
        });
        record(actor, `note · ${account.name}`);
        // Read from the rendered state, for the same reason `toggleSort` computes outside the
        // updater: an updater can run twice, so a count incremented inside one is not a count.
        return (overrides.notes[account.id] ?? []).length + 1;
      },

      saveView(name, actor) {
        const trimmed = name.trim();
        if (trimmed === '') throw new Error('a view needs a name');
        const view: SavedView = { name: trimmed, filters, sort };
        setViews((current) => [...current.filter((held) => held.name !== trimmed), view]);
        record(actor, `saved view · ${trimmed}`);
        return view;
      },

      applyView(name, actor) {
        const view = views.find((held) => held.name === name);
        if (view === undefined) {
          throw new Error(
            `no saved view named "${name}" — there ${views.length === 1 ? 'is' : 'are'} ${views.length}`,
          );
        }
        setFiltersState(view.filters);
        setSortState(view.sort);
        record(actor, `applied view · ${view.name}`);
        return view;
      },
    };
    // `accounts` is no longer here: with `countWith` gone, nothing in this memo reads the account list
    // directly. What needed it — `find` — depends on it itself and is listed below.
  }, [filters, sort, rows, totals, selected, views, activity, overrides.notes, find, record]);

  latest.current = dashboard;

  return <DashboardContext.Provider value={dashboard}>{children}</DashboardContext.Provider>;
}

/** Reads the dashboard. Throws rather than returning a stub — a stub would fail silently. */
export function useDashboard(): Dashboard {
  const dashboard = useContext(DashboardContext);
  if (dashboard === undefined) {
    throw new Error('useDashboard was called outside DashboardProvider');
  }
  return dashboard;
}
