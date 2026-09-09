// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { applyFill, applySelect } from '../../../src/dom/interact.ts';

// Filling a CONTROLLED React input, asserted through the APPLICATION rather than through the DOM.
//
// **A case that asserted `element.value` would pass for the broken implementation**, and that is the
// whole reason this file renders a real React tree instead of using a jsdom fixture. Measured before
// it was written:
//
//     element.value = x; dispatch 'input'  ->  DOM "naive",  React state ""
//     native setter;     dispatch 'input'  ->  DOM "proper", React state "proper"
//
// React tracks the last value it wrote on the node. Assigning `.value` updates that tracker as a SIDE
// EFFECT, so React concludes nothing changed and never runs the handler — then overwrites the DOM on
// its next render. The agent is told the field was filled, a person watches the value appear and
// vanish, and the application never had it. Every step reports success.
//
// So each case here asserts two things: the application's state, and that the value SURVIVES the next
// render. The second is what catches the failure a snapshot taken immediately would miss.

function Controlled(): React.ReactNode {
  const [text, setText] = useState('');
  const [choice, setChoice] = useState('a');
  const [renders, setRenders] = useState(0);
  return (
    <>
      <input aria-label="Search" value={text} onChange={(event) => setText(event.target.value)} />
      <textarea aria-label="Notes" value={text} onChange={(event) => setText(event.target.value)} />
      <select
        aria-label="Health"
        value={choice}
        onChange={(event) => setChoice(event.target.value)}
      >
        <option value="a">Healthy</option>
        <option value="b">At risk</option>
      </select>
      <p data-testid="state">
        text={text} choice={choice}
      </p>
      <button type="button" onClick={() => setRenders((n) => n + 1)}>
        rerender {renders}
      </button>
    </>
  );
}

/** Lets React process the event and commit. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('filling a controlled React input', () => {
  it('reaches the application’s own state, not just the DOM', async () => {
    render(<Controlled />);
    const input = screen.getByLabelText('Search');

    expect(applyFill(input, 'acme').operable).toBe(true);
    await settle();

    // THE ASSERTION THAT MATTERS. `input.value` would be "acme" even for the broken implementation.
    expect(screen.getByTestId('state').textContent).toContain('text=acme');
  });

  it('survives the application’s next render — the half a snapshot would miss', async () => {
    render(<Controlled />);
    const input = screen.getByLabelText('Search') as HTMLInputElement;
    applyFill(input, 'acme');
    await settle();

    // Force an unrelated render. The broken implementation loses the value HERE, not at the fill.
    screen.getByText(/^rerender/).click();
    await settle();

    expect(screen.getByTestId('state').textContent).toContain('text=acme');
    expect(input.value).toBe('acme');
  });

  it('works on a textarea, whose value setter lives on its own prototype', async () => {
    render(<Controlled />);
    expect(applyFill(screen.getByLabelText('Notes'), 'a note').operable).toBe(true);
    await settle();
    expect(screen.getByTestId('state').textContent).toContain('text=a note');
  });
});

describe('choosing an option in a controlled select', () => {
  it('chooses by the LABEL the snapshot reported, and reaches the application', async () => {
    render(<Controlled />);
    // By label rather than by `value`: the label is what the agent was told, and the `value` attribute
    // is markup it never saw.
    expect(applySelect(screen.getByLabelText('Health'), 'At risk').operable).toBe(true);
    await settle();
    expect(screen.getByTestId('state').textContent).toContain('choice=b');
  });

  it('refuses a label no option carries, rather than choosing something else', async () => {
    render(<Controlled />);
    expect(applySelect(screen.getByLabelText('Health'), 'Churning').operable).toBe(false);
    await settle();
    expect(screen.getByTestId('state').textContent).toContain('choice=a');
  });
});

describe('the naive implementation, kept as evidence', () => {
  it('leaves the application’s state EMPTY while the DOM shows the value', async () => {
    // **Not a test of this library — a test of the claim this library's design rests on**, pinned so
    // it cannot quietly stop being true. If React ever makes direct assignment work, this goes red and
    // the native-setter machinery becomes unnecessary rather than merely unexplained.
    render(<Controlled />);
    const input = screen.getByLabelText('Search') as HTMLInputElement;

    input.value = 'naive';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();

    expect(input.value, 'the DOM took it').toBe('naive');
    expect(
      screen.getByTestId('state').textContent,
      'and the application never saw it — which is why the native setter exists',
    ).toContain('text=');
    expect(screen.getByTestId('state').textContent).not.toContain('naive');
  });
});

describe('both events are dispatched, and both are needed', () => {
  it('reaches a listener that only listens for `change`', async () => {
    // **Added because a break-it did not go red.** Removing the `change` dispatch left every case
    // above green, because a controlled React input only needs `input` — so the source comment
    // claiming a plain form listener needs `change` was a claim nothing checked.
    //
    // It is a real claim: a form written without React, or one using an uncontrolled input with an
    // `onChange`-style listener, hears `change` and not `input`. A tool that worked on React pages and
    // silently did nothing on the rest would be a tool that works on some pages.
    document.body.innerHTML = '<input id="plain">';
    const input = document.getElementById('plain') as HTMLInputElement;
    const heard: string[] = [];
    input.addEventListener('change', () => heard.push('change'));
    input.addEventListener('input', () => heard.push('input'));

    applyFill(input, 'typed');
    await settle();

    expect(heard, 'both events reach a listener, in the order typing produces them').toEqual([
      'input',
      'change',
    ]);
  });

  it('dispatches both for a select too', async () => {
    document.body.innerHTML =
      '<select id="s"><option value="x">One</option><option value="y">Two</option></select>';
    const select = document.getElementById('s') as HTMLSelectElement;
    const heard: string[] = [];
    select.addEventListener('change', () => heard.push('change'));
    select.addEventListener('input', () => heard.push('input'));

    applySelect(select, 'Two');
    await settle();

    expect(select.value).toBe('y');
    expect(heard).toEqual(['input', 'change']);
  });
});
