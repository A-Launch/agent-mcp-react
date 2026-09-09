// The closed sets `dom.press` and `dom.scroll` accept.
//
// A VOCABULARY: it names values and decides nothing.
//
// **Why closed, and why these members.** A free-text key field is a typing surface by another name,
// and typing is `dom.fill`'s — it would also invite modifier syntax (`Ctrl+Shift+K`), which is a
// keyboard-macro language this library is not going to specify. The nine keys below are the ones that
// operate an interface rather than compose text: they dismiss, submit, move focus, and navigate a
// listbox.
//
// The same reasoning bounds scrolling. Pixel offsets are absent because a pixel is a fact about a
// viewport the agent cannot see — an agent that could scroll to arbitrary coordinates would be doing
// geometry rather than acting on something it was shown, which is the browser-automation posture the
// non-goals (`docs/design.md#non-goals`) rule out, arriving through the one tool nobody would think to
// guard.

/** The keys `dom.press` admits. Names as the platform spells them, so nothing has to be translated. */
export const PRESSABLE_KEY = {
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowUp: 'ArrowUp',
  arrowDown: 'ArrowDown',
  arrowLeft: 'ArrowLeft',
  arrowRight: 'ArrowRight',
} as const;

export type PressableKey = (typeof PRESSABLE_KEY)[keyof typeof PRESSABLE_KEY];

/** Membership derived from the dictionary, never re-listed — a closed set is spelled once. */
const PRESSABLE_KEYS: ReadonlySet<string> = new Set(Object.values(PRESSABLE_KEY));

export function isPressableKey(value: string): value is PressableKey {
  return PRESSABLE_KEYS.has(value);
}

/** The permitted values, in declaration order, for the tool's declared schema. */
export const PRESSABLE_KEY_VALUES: readonly PressableKey[] = Object.values(PRESSABLE_KEY);

/** Where `dom.scroll` may move. Relative to an element, never to a coordinate space. */
export const SCROLL_DIRECTION = {
  up: 'up',
  down: 'down',
  top: 'top',
  bottom: 'bottom',
} as const;

export type ScrollDirection = (typeof SCROLL_DIRECTION)[keyof typeof SCROLL_DIRECTION];

const SCROLL_DIRECTIONS: ReadonlySet<string> = new Set(Object.values(SCROLL_DIRECTION));

export function isScrollDirection(value: string): value is ScrollDirection {
  return SCROLL_DIRECTIONS.has(value);
}

export const SCROLL_DIRECTION_VALUES: readonly ScrollDirection[] = Object.values(SCROLL_DIRECTION);
