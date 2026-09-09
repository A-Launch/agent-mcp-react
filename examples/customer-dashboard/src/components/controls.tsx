import type { ReactNode } from 'react';

// The dashboard's small reusable controls. Presentation only — every one of them reports a change
// upward and holds no state of its own, so the dashboard stays the single owner of what is filtered.
//
// None of these knows an agent exists. That is the point: the tools call the same transitions these
// controls call, one level up, rather than these components learning to be driven twice.

export function SearchField(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
}): ReactNode {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <input
        type="search"
        className="text-input"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

/**
 * A multi-select rendered as toggleable chips.
 *
 * Selecting nothing means "no restriction", not "match nothing" — the same rule the filter functions
 * apply, stated once in each place a reader might look for it.
 */
export function ChipGroup<T extends string>(props: {
  readonly label: string;
  readonly options: readonly T[];
  readonly selected: readonly T[];
  readonly labelFor: (value: T) => string;
  readonly onChange: (next: T[]) => void;
}): ReactNode {
  const toggle = (value: T): void => {
    const next = props.selected.includes(value)
      ? props.selected.filter((held) => held !== value)
      : [...props.selected, value];
    props.onChange(next);
  };

  return (
    <div className="field">
      <span className="field-label">{props.label}</span>
      <div className="chips">
        {props.options.map((option) => {
          const on = props.selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              className={on ? 'chip chip-on' : 'chip'}
              aria-pressed={on}
              onClick={() => toggle(option)}
            >
              {props.labelFor(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A bounded numeric field whose empty state is a real value.
 *
 * An empty input reports `null` — "no bound" — rather than `0`, because a `0` lower bound and no
 * lower bound filter identically today and stop doing so the moment a negative value exists.
 */
export function NumberField(props: {
  readonly label: string;
  readonly value: number | null;
  readonly suffix?: string;
  readonly onChange: (value: number | null) => void;
}): ReactNode {
  return (
    <label className="field field-inline">
      <span className="field-label">{props.label}</span>
      <span className="number-wrap">
        <input
          type="number"
          className="number-input"
          value={props.value ?? ''}
          onChange={(event) => {
            const raw = event.target.value;
            props.onChange(raw === '' ? null : Number(raw));
          }}
        />
        {props.suffix === undefined ? null : <span className="suffix">{props.suffix}</span>}
      </span>
    </label>
  );
}

export function Toggle(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <label className="field field-toggle">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}
