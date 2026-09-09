// The closed set of roles a snapshot may report, and the mapping from an element to one of them.
//
// A VOCABULARY: it names values and decides nothing. Whether an element is perceivable is
// `perceivable.ts`'s question, and whether a call may happen at all is the runtime's.
//
// **Why a closed set rather than "whatever `role` says or whatever the tag implies".** A closed set of
// literals is declared once, with membership derived from the dictionary rather than spelled at each
// site, and here it does a second job: the set is what bounds a snapshot. An open traversal would
// report every `<div>` in the page, which is how `dom.snapshot` becomes the page-HTML dump the DOM
// fallback's design forbids (`docs/dom-inspection.md#what-never-reaches-the-agent`) in a different
// costume.
//
// **The set covers three KINDS, and the third is the one an implementation forgets**:
//
//   1. Controls a person can operate — button, textbox, checkbox, link, …
//   2. Structure telling them where they are — heading, and the landmarks.
//   3. Text telling them what happened — `status` and `alert`.
//
// Without the third, `dom.get_text` is unusable for the thing most worth reading: an agent gets refs
// for every button on a failed form and none for the error explaining why it failed.

/**
 * Every role a snapshot may report.
 *
 * ARIA names, because that is what an agent's training and an accessibility tree both use — a private
 * vocabulary here would make the snapshot describable only to something that had read this file.
 */
export const SNAPSHOT_ROLE = {
  // 1 — controls
  button: 'button',
  link: 'link',
  textbox: 'textbox',
  searchbox: 'searchbox',
  checkbox: 'checkbox',
  radio: 'radio',
  combobox: 'combobox',
  listbox: 'listbox',
  option: 'option',
  slider: 'slider',
  spinbutton: 'spinbutton',
  switch: 'switch',
  tab: 'tab',
  menuitem: 'menuitem',
  // 2 — structure
  heading: 'heading',
  navigation: 'navigation',
  main: 'main',
  banner: 'banner',
  contentinfo: 'contentinfo',
  complementary: 'complementary',
  form: 'form',
  search: 'search',
  region: 'region',
  dialog: 'dialog',
  alertdialog: 'alertdialog',
  table: 'table',
  row: 'row',
  cell: 'cell',
  columnheader: 'columnheader',
  list: 'list',
  listitem: 'listitem',
  // 3 — text that reports state
  status: 'status',
  alert: 'alert',
  progressbar: 'progressbar',
} as const;

export type SnapshotRole = (typeof SNAPSHOT_ROLE)[keyof typeof SNAPSHOT_ROLE];

/** Membership derived from the dictionary, never re-listed — a closed set is spelled once. */
const SNAPSHOT_ROLES: ReadonlySet<string> = new Set(Object.values(SNAPSHOT_ROLE));

export function isSnapshotRole(value: string): value is SnapshotRole {
  return SNAPSHOT_ROLES.has(value);
}

/**
 * The implicit role of an `<input>`, by its `type`.
 *
 * `hidden` is deliberately ABSENT rather than mapped to something harmless. An input that is not
 * perceivable has no role in this vocabulary, so it cannot enter a snapshot through this door at all —
 * which is one of the two independent reasons a hidden input's value never reaches an agent —
 * invariant 13 in `docs/design.md#security-invariants`.
 * The other is the value site in `snapshot.ts`, and two independent reasons is what stops one
 * refactor removing both.
 */
const INPUT_ROLE: Readonly<Record<string, SnapshotRole>> = {
  button: SNAPSHOT_ROLE.button,
  submit: SNAPSHOT_ROLE.button,
  reset: SNAPSHOT_ROLE.button,
  image: SNAPSHOT_ROLE.button,
  checkbox: SNAPSHOT_ROLE.checkbox,
  radio: SNAPSHOT_ROLE.radio,
  range: SNAPSHOT_ROLE.slider,
  number: SNAPSHOT_ROLE.spinbutton,
  search: SNAPSHOT_ROLE.searchbox,
  // Everything else that takes typing is a textbox, INCLUDING `password`. The element is reported;
  // its value is not — a password value is redacted unconditionally, invariant 12 in
  // `docs/design.md#security-invariants`. An agent must be able to see that a password is being asked
  // for.
  text: SNAPSHOT_ROLE.textbox,
  email: SNAPSHOT_ROLE.textbox,
  password: SNAPSHOT_ROLE.textbox,
  tel: SNAPSHOT_ROLE.textbox,
  url: SNAPSHOT_ROLE.textbox,
  date: SNAPSHOT_ROLE.textbox,
  'datetime-local': SNAPSHOT_ROLE.textbox,
  month: SNAPSHOT_ROLE.textbox,
  week: SNAPSHOT_ROLE.textbox,
  time: SNAPSHOT_ROLE.textbox,
};

/** The implicit role of an element by tag name, where the tag alone decides it. */
const TAG_ROLE: Readonly<Record<string, SnapshotRole>> = {
  BUTTON: SNAPSHOT_ROLE.button,
  SELECT: SNAPSHOT_ROLE.combobox,
  TEXTAREA: SNAPSHOT_ROLE.textbox,
  OPTION: SNAPSHOT_ROLE.option,
  NAV: SNAPSHOT_ROLE.navigation,
  MAIN: SNAPSHOT_ROLE.main,
  HEADER: SNAPSHOT_ROLE.banner,
  FOOTER: SNAPSHOT_ROLE.contentinfo,
  ASIDE: SNAPSHOT_ROLE.complementary,
  FORM: SNAPSHOT_ROLE.form,
  DIALOG: SNAPSHOT_ROLE.dialog,
  TABLE: SNAPSHOT_ROLE.table,
  TR: SNAPSHOT_ROLE.row,
  TD: SNAPSHOT_ROLE.cell,
  TH: SNAPSHOT_ROLE.columnheader,
  UL: SNAPSHOT_ROLE.list,
  OL: SNAPSHOT_ROLE.list,
  LI: SNAPSHOT_ROLE.listitem,
  H1: SNAPSHOT_ROLE.heading,
  H2: SNAPSHOT_ROLE.heading,
  H3: SNAPSHOT_ROLE.heading,
  H4: SNAPSHOT_ROLE.heading,
  H5: SNAPSHOT_ROLE.heading,
  H6: SNAPSHOT_ROLE.heading,
  OUTPUT: SNAPSHOT_ROLE.status,
  PROGRESS: SNAPSHOT_ROLE.progressbar,
};

/**
 * The role this element reports, or nothing.
 *
 * An explicit `role` wins, and is honoured only when it names a member of the closed set — an author
 * who wrote `role="widget"` gets no entry rather than an entry this vocabulary cannot describe.
 *
 * **`undefined` means "not in the snapshot at all", not "role unknown".** That is what keeps a
 * snapshot semantic: an element nothing here can describe is one an agent has no business addressing,
 * and reporting it with an empty role would fill the 500-element budget with `<div>`s.
 */
export function roleOf(element: Element): SnapshotRole | undefined {
  const declared = element.getAttribute('role')?.trim().toLowerCase();
  if (declared !== undefined && declared !== '' && isSnapshotRole(declared)) return declared;
  // An `<a>` is only a link when it can be followed. A bare anchor is a text container.
  if (element.tagName === 'A') {
    return element.hasAttribute('href') ? SNAPSHOT_ROLE.link : undefined;
  }
  if (element.tagName === 'INPUT') {
    const type = (element.getAttribute('type') ?? 'text').trim().toLowerCase();
    return INPUT_ROLE[type];
  }
  return TAG_ROLE[element.tagName];
}

/**
 * The roles whose accessible name may be taken from their own text content.
 *
 * **Found in a live browser, and it was doing real harm.** Without this restriction the demonstrator's
 * `banner` landmark reported a name of *"Customer bookA filterable SaaS page. Everything an a…"* — its
 * entire subtree, truncated. A container's text content is everything inside it, so deriving a name
 * from it turns every landmark into a blob of the page: useless to an agent matching on names, and it
 * spends the element budget and the payload on text that is already reported element by element.
 *
 * The set is ARIA's own "name from content" list, restricted to the roles this vocabulary admits — a
 * control or a piece of content is named by what it says; a container is named only if somebody
 * labelled it.
 *
 * **`status` and `alert` are a deliberate addition to that list**, and stated as one rather than
 * smuggled in. ARIA does not give them name-from-content. But a live region's content IS the message,
 * it is short by nature, and it is the single thing an agent most needs to see on a page that has just
 * failed — the non-interactive roles in this set exist for exactly that. The alternative is an unnamed ref and a second round trip
 * to `dom.get_text` for every status on the page.
 */
const NAME_FROM_CONTENT: ReadonlySet<SnapshotRole> = new Set([
  SNAPSHOT_ROLE.button,
  SNAPSHOT_ROLE.link,
  SNAPSHOT_ROLE.heading,
  SNAPSHOT_ROLE.option,
  SNAPSHOT_ROLE.checkbox,
  SNAPSHOT_ROLE.radio,
  SNAPSHOT_ROLE.switch,
  SNAPSHOT_ROLE.tab,
  SNAPSHOT_ROLE.menuitem,
  SNAPSHOT_ROLE.cell,
  SNAPSHOT_ROLE.columnheader,
  SNAPSHOT_ROLE.row,
  SNAPSHOT_ROLE.listitem,
  SNAPSHOT_ROLE.status,
  SNAPSHOT_ROLE.alert,
]);

/** Whether this role may be named by what it says, rather than only by what labelled it. */
export function namesFromContent(role: SnapshotRole): boolean {
  return NAME_FROM_CONTENT.has(role);
}
