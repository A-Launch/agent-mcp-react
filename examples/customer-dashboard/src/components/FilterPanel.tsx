import { useMcpState, useMcpTool } from '@agent-mcp/react';
import type { ReactNode } from 'react';
import {
  ACTOR,
  HEALTH,
  type Health,
  LABEL,
  PLAN,
  type Plan,
  REGION,
  type Region,
  SEGMENT,
  type Segment,
} from '../domain/vocabulary.ts';
import { useDashboard } from '../state/dashboard.tsx';
import {
  activeFilterNames,
  FILTER_FIELD,
  narrowingValues,
  readFilterPatch,
} from '../state/filters.ts';
import { ChipGroup, NumberField, SearchField, Toggle } from './controls.tsx';

// The filter rail, and the two tools that reach the same transitions its controls do.
//
// The tools are declared HERE, in the component that owns filtering, rather than in a central tool
// file. That is not a style preference: registration follows the component's lifetime, so a tool
// declared next to the feature it drives disappears exactly when the feature leaves the page. A
// central registry of tool declarations would be a second owner of "what this application exposes",
// and it would keep exposing a filter tool after the rail unmounted. One owner per truth: the
// component that owns the feature owns the tool that reaches it.
//
// Both tools call `dashboard.setFilters` / `dashboard.clearFilters` — the very functions the chips and
// the search box below call. There is no filtering path an agent can take that a person cannot.

const SEGMENTS = Object.values(SEGMENT);
const REGIONS = Object.values(REGION);
const HEALTHS = Object.values(HEALTH);
const PLANS = Object.values(PLAN);
const FILTER_FIELDS = Object.values(FILTER_FIELD);

export function FilterPanel(): ReactNode {
  const dashboard = useDashboard();
  const { filters } = dashboard;
  const active = activeFilterNames(filters);

  useMcpTool({
    name: 'customers.set_filters',
    title: 'Filter the customer list',
    description:
      'Narrow the customer table. Every field is optional and merges over what is already applied. ' +
      'To drop a filter, name it in `clear` rather than omitting it. Returns how many accounts ' +
      'match afterwards.',
    // No union types anywhere in this schema, on purpose. Clearing a filter is the `clear` list
    // rather than a `null` value, because "string or null" needs a union and unions are the part of
    // JSON Schema that tool consumers handle least consistently — a schema a model cannot be given is
    // a tool it cannot call.
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free text matched against account name and owner.',
        },
        segments: {
          type: 'array',
          items: { type: 'string', enum: SEGMENTS },
          description: 'Commercial tiers to keep. An empty array means every tier.',
        },
        regions: {
          type: 'array',
          items: { type: 'string', enum: REGIONS },
          description: 'Sales regions to keep.',
        },
        health: {
          type: 'array',
          items: { type: 'string', enum: HEALTHS },
          description: 'Relationship health values to keep.',
        },
        plans: {
          type: 'array',
          items: { type: 'string', enum: PLANS },
          description: 'Subscription plans to keep.',
        },
        arrMin: {
          type: 'number',
          description: 'Lowest annual recurring revenue, in dollars.',
        },
        arrMax: {
          type: 'number',
          description: 'Highest annual recurring revenue, in dollars.',
        },
        renewalWithinDays: {
          type: 'number',
          description:
            'Keep only contracts renewing within this many days. Negative days are lapsed.',
        },
        openTicketsOnly: {
          type: 'boolean',
          description: 'Keep only accounts with at least one open support ticket.',
        },
        clear: {
          type: 'array',
          items: { type: 'string', enum: FILTER_FIELDS },
          description: 'Filters to reset to no restriction. Applied before the fields above.',
        },
      },
      additionalProperties: false,
    },
    handler: async (input, context) => {
      // Argument checking used to be the APPLICATION's job and this handler is where that cost showed.
      // The library now checks every value against the schema declared above, in the runtime, before
      // this line runs — so `readFilterPatch` no longer validates anything and only normalizes.
      const patch = readFilterPatch(input);
      if (Object.keys(patch).length === 0) {
        throw new Error('name at least one filter field to change');
      }
      dashboard.setFilters(patch, ACTOR.agent);

      // **A call settles after the commit, demonstrated rather than described**
      // (docs/design.md#a-call-settles-after-the-commit). Resolve only after the application has accepted
      // the change — which here means the table has rendered it, because that is what an agent reading
      // "matched: 12" will assume the number describes.
      //
      // This replaced a recomputation. The handler used to answer by running the filter selection a
      // second time against the patch it had just dispatched, because the dashboard had not rerendered
      // yet and reading `totals` would have reported the PREVIOUS filter set. That worked and was a
      // second implementation of what the render does, kept in step by hand.
      await context.afterRender();

      // `current()` and not the closed-over `dashboard`: this closure belongs to the render that
      // created it, and the commit we just waited for produced a different one.
      const now = dashboard.current();
      return { applied: patch, matched: now.totals.matched, of: now.totals.total };
    },
  });

  useMcpTool({
    name: 'customers.clear_filters',
    title: 'Clear every filter',
    description: 'Remove all filters and show every account. Sorting is left alone.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_input, context) => {
      dashboard.clearFilters(ACTOR.agent);
      await context.afterRender();
      return { cleared: active, matched: dashboard.current().totals.matched };
    },
  });

  // The READ half, declared beside the two tools that write. An agent that has just called
  // `customers.set_filters` can ask what the page is now showing instead of assuming — which is the
  // whole argument for exposing state (docs/exposing-state.md), and the shape steps 9 and 10 of the
  // acceptance scenario (docs/design.md#the-acceptance-scenario) need.
  //
  // **`getState` is the disclosure boundary, and this is what taking that seriously looks like.** The
  // dashboard object in scope carries `views`, `activity`, `selected`, per-account notes and every
  // account row. `getState: () => dashboard` would be shorter, would type-check, and would ship all of
  // it to the agent. What crosses instead is the four things an agent needs to know where it is:
  // what is filtered, how it is sorted, how many matched, and out of how many.
  //
  // The schema is enforced exactly as written and is NOT a redactor — it would not have stopped any of
  // those fields crossing if this getter had returned them. Choosing them here is the control.
  useMcpState({
    name: 'customers',
    description:
      'What the customer table is currently showing: the active filters, the sort order, and how ' +
      'many accounts match out of the total.',
    schema: {
      type: 'object',
      properties: {
        filters: {
          type: 'object',
          description:
            'The filters actually narrowing the list: their names, and the values each is set to.',
          properties: {
            active: { type: 'array', items: { type: 'string' } },
            query: { type: 'string' },
            // **The VALUES, not only which fields are set.** Without this an agent that called
            // `set_filters({ health: ['at_risk'] })` reads back `active: ['health']` and still cannot
            // tell WHICH health it applied — so it cannot verify its own call, which is the entire
            // reason a state read exists (docs/exposing-state.md) and what step 10 of the acceptance
            // scenario (docs/design.md#the-acceptance-scenario) asks for.
            //
            // Still an explicit projection and still the disclosure boundary: what crosses is chosen
            // here, field by field. The dashboard object in scope also holds `views`, `activity`,
            // `selected`, per-account notes and every account row, and none of them cross.
            values: {
              type: 'object',
              description: 'Each narrowing filter and what it is set to.',
              properties: {
                segments: { type: 'array', items: { type: 'string' } },
                regions: { type: 'array', items: { type: 'string' } },
                health: { type: 'array', items: { type: 'string' } },
                plans: { type: 'array', items: { type: 'string' } },
                arrMin: { type: 'number' },
                arrMax: { type: 'number' },
                renewalWithinDays: { type: 'number' },
                openTicketsOnly: { type: 'boolean' },
              },
            },
          },
          required: ['active', 'values'],
        },
        sort: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            direction: { type: 'string' },
          },
          required: ['field', 'direction'],
        },
        matched: { type: 'number', description: 'Accounts matching the current filters.' },
        total: { type: 'number', description: 'Accounts before filtering.' },
      },
      required: ['filters', 'sort', 'matched', 'total'],
    },
    getState: () => ({
      filters: { active, query: filters.query, values: narrowingValues(filters) },
      sort: { field: dashboard.sort.field, direction: dashboard.sort.direction },
      matched: dashboard.totals.matched,
      total: dashboard.totals.total,
    }),
  });

  return (
    <aside className="rail" aria-label="Filters">
      <header className="rail-head">
        <h2>Filters</h2>
        <button
          type="button"
          className="link-button"
          disabled={active.length === 0}
          onClick={() => dashboard.clearFilters(ACTOR.person)}
        >
          Clear all
        </button>
      </header>

      <SearchField
        label="Search"
        value={filters.query}
        placeholder="name or owner"
        onChange={(query) => dashboard.setFilters({ query }, ACTOR.person)}
      />

      <ChipGroup<Segment>
        label="Segment"
        options={SEGMENTS}
        selected={filters.segments}
        labelFor={(value) => LABEL[value] ?? value}
        onChange={(segments) => dashboard.setFilters({ segments }, ACTOR.person)}
      />

      <ChipGroup<Region>
        label="Region"
        options={REGIONS}
        selected={filters.regions}
        labelFor={(value) => LABEL[value] ?? value}
        onChange={(regions) => dashboard.setFilters({ regions }, ACTOR.person)}
      />

      <ChipGroup<Health>
        label="Health"
        options={HEALTHS}
        selected={filters.health}
        labelFor={(value) => LABEL[value] ?? value}
        onChange={(health) => dashboard.setFilters({ health }, ACTOR.person)}
      />

      <ChipGroup<Plan>
        label="Plan"
        options={PLANS}
        selected={filters.plans}
        labelFor={(value) => LABEL[value] ?? value}
        onChange={(plans) => dashboard.setFilters({ plans }, ACTOR.person)}
      />

      <div className="field-row">
        <NumberField
          label="ARR from"
          value={filters.arrMin}
          suffix="$"
          onChange={(arrMin) => dashboard.setFilters({ arrMin }, ACTOR.person)}
        />
        <NumberField
          label="to"
          value={filters.arrMax}
          suffix="$"
          onChange={(arrMax) => dashboard.setFilters({ arrMax }, ACTOR.person)}
        />
      </div>

      <NumberField
        label="Renewing within"
        value={filters.renewalWithinDays}
        suffix="days"
        onChange={(renewalWithinDays) => dashboard.setFilters({ renewalWithinDays }, ACTOR.person)}
      />

      <Toggle
        label="Only accounts with open tickets"
        checked={filters.openTicketsOnly}
        onChange={(openTicketsOnly) => dashboard.setFilters({ openTicketsOnly }, ACTOR.person)}
      />

      <p className="rail-foot">
        {active.length === 0
          ? 'No filters applied.'
          : `${active.length} filter${active.length === 1 ? '' : 's'} applied.`}
      </p>
    </aside>
  );
}
