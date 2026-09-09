import { useMcpTool } from 'agent-mcp-react';
import type { ReactNode } from 'react';
import {
  ACCOUNT_FORM_FIELDS,
  actionName,
  type FormFieldSpec,
  PANEL_ACTION,
} from '../../catalog/kinds.ts';
import { ACCOUNT_PLAN, type AccountPlan, type PANEL_KIND } from '../../catalog/vocabulary.ts';
import { appendAccount } from '../../data/sources.ts';
import { notifyDataChanged, type Panel, updateSettings } from '../../state/board.ts';

// A form that creates an account, with a person on the submit button.
//
// **The fields are the catalog's, never the agent's.** An agent chooses to put a form on the board; it
// does not choose what the form asks for. That is the same boundary the panel catalog draws, one level
// down.
//
// **One field is marked secret, and what that means is enforced elsewhere.** The value lives in this
// panel's settings like any other, and `Board.tsx` is the single place that decides what a read of the
// board reports — the library traverses nothing and injects nothing, so `getState` is the disclosure
// boundary and there is no second place to get it wrong.
//
// What this component owns: rendering the fields, the human submit path, and (from user story 4) the two
// actions that let an agent propose values and ask for a submission a person confirms.

export type FormPanelModel = Extract<Panel, { kind: typeof PANEL_KIND.form }>;

/** The fields this form asks for. One list, read by the renderer, the tools and the board's state read. */
export const FORM_FIELDS: readonly FormFieldSpec[] = ACCOUNT_FORM_FIELDS;

/** Whether a submission has everything it needs. The same check for a person and for an agent. */
export function missingRequired(values: Readonly<Record<string, string>>): readonly string[] {
  return FORM_FIELDS.filter((field) => (values[field.name] ?? '').trim() === '').map(
    (field) => field.name,
  );
}

function asPlan(value: string | undefined): AccountPlan {
  // The declared enum is what admits a plan; this only turns an admitted string into the union type
  // without an `as`-cast onto a type that does not admit it.
  return (Object.values(ACCOUNT_PLAN) as readonly string[]).includes(value ?? '')
    ? (value as AccountPlan)
    : ACCOUNT_PLAN.free;
}

/**
 * Creates the account this form describes.
 *
 * **Called by the person's button and, from user story 4, by the agent's confirmed action — the same
 * function, never an equivalent second path.** That is what makes "the agent and the person create an
 * account the same way" true in the code rather than remembered as a rule.
 */
export function submitForm(panel: FormPanelModel): { readonly created: string } {
  const values = panel.settings.values;
  const missing = missingRequired(values);
  if (missing.length > 0) {
    throw new Error(`this form still needs: ${missing.join(', ')}`);
  }

  appendAccount({
    name: (values.name ?? '').trim(),
    owner: (values.owner_email ?? '').trim(),
    plan: asPlan(values.plan),
    region: 'amer',
    revenue: 0,
    health: 'healthy',
  });

  // The form is emptied so the next submission starts clean — including the secret field, which must not
  // outlive the submission it was for.
  updateSettings<typeof PANEL_KIND.form>(panel.id, { values: {} });
  notifyDataChanged();
  return { created: (values.name ?? '').trim() };
}

export function FormPanel({ panel }: { readonly panel: FormPanelModel }): ReactNode {
  const values = panel.settings.values;

  // **Proposing values is not submitting**, and the two are separate tools for that reason rather than
  // one tool with a flag. A flag makes "fill it in and submit" a single argument away from happening by
  // accident; two tools make the second one a decision.
  //
  // The result names WHICH fields were filled and reports no values — uniformly, including for
  // non-secret ones. The agent supplied them and does not need them echoed, and a result shape that
  // varied by secrecy is one an author gets wrong the first time a field's `secret` flag changes.
  useMcpTool({
    name: actionName(panel.id, PANEL_ACTION.fill),
    title: `Fill in ${panel.id}`,
    description:
      `Proposes values for the "${panel.id}" form. This does NOT submit it — a person has to confirm ` +
      'that separately. Every field is optional; omitted fields keep what they hold.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        FORM_FIELDS.map((field) => [
          field.name,
          field.type === 'enum'
            ? { type: 'string', enum: field.options ?? [], description: field.label }
            : { type: 'string', maxLength: 200, description: field.label },
        ]),
      ),
    },
    handler: async (input, context) => {
      const next: Record<string, string> = { ...values };
      const filled: string[] = [];
      for (const field of FORM_FIELDS) {
        const proposed = input[field.name];
        if (typeof proposed === 'string') {
          next[field.name] = proposed;
          filled.push(field.name);
        }
      }
      updateSettings<typeof PANEL_KIND.form>(panel.id, { values: next });
      await context.afterRender();
      return { filled };
    },
  });

  // **A person holds this button.** `confirmation: 'required'` resolves BEFORE the handler, never by
  // undoing an effect afterwards, and a declined confirmation settles as a refusal with the form
  // unsubmitted.
  //
  // It fails SAFE if the provider has no resolver: every call is refused with
  // `MCP_TOOL_CONFIRMATION_UNAVAILABLE` and no prompt ever appears. That is the right direction to fail
  // in and it is also why only a live run catches a half-wired surface — the page looks instrumented.
  useMcpTool({
    name: actionName(panel.id, PANEL_ACTION.submit),
    title: `Submit ${panel.id}`,
    description:
      `Creates the account the "${panel.id}" form describes. A person must confirm this before it ` +
      'happens. Fill the form first: a submission missing a required field returns `ok: false` with a ' +
      '`refused` message naming which fields are still empty.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    permissions: { confirmation: 'required' },
    handler: async (_input, context) => {
      // A refusal is RETURNED, never thrown. A thrown message is replaced with a generic
      // `MCP_TOOL_EXECUTION_ERROR` outside a development build — correct, because an exception can carry
      // things the agent was never meant to see — so guidance the agent should act on has to travel as
      // a result. See `shell-tools.ts` for the full reasoning; this is the same rule one level down.
      try {
        const created = submitForm(panel);
        await context.afterRender();
        return { ok: true, ...created };
      } catch (cause) {
        return { ok: false, refused: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  });

  const setValue = (name: string, value: string): void => {
    updateSettings<typeof PANEL_KIND.form>(panel.id, {
      values: { ...values, [name]: value },
    });
  };

  return (
    <div className="panel" data-testid={`panel-${panel.id}`} data-panel-kind={panel.kind}>
      <div className="panel-head">
        <h3>New account</h3>
        <span className="panel-id">{panel.id}</span>
      </div>
      <div className="panel-body">
        {FORM_FIELDS.map((field) => (
          <div className="field" key={field.name}>
            <label htmlFor={`${panel.id}-${field.name}`}>{field.label}</label>
            {field.type === 'enum' ? (
              <select
                id={`${panel.id}-${field.name}`}
                data-testid={`field-${panel.id}-${field.name}`}
                value={values[field.name] ?? ''}
                onChange={(event) => setValue(field.name, event.target.value)}
              >
                <option value="">choose…</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${panel.id}-${field.name}`}
                data-testid={`field-${panel.id}-${field.name}`}
                // A secret field is a password input so a person's screen does not show it either. This
                // is presentation; what keeps it from the AGENT is the omission in `Board.tsx`.
                type={field.secret ? 'password' : field.type === 'email' ? 'email' : 'text'}
                value={values[field.name] ?? ''}
                onChange={(event) => setValue(field.name, event.target.value)}
              />
            )}
            {field.secret ? <span className="secret-note">never reported to the agent</span> : null}
          </div>
        ))}
        <button
          type="button"
          className="primary"
          data-testid={`submit-${panel.id}`}
          disabled={missingRequired(values).length > 0}
          onClick={() => submitForm(panel)}
        >
          Create account
        </button>
      </div>
    </div>
  );
}
