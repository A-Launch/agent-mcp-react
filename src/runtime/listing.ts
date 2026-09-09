import { admitsAvailability, type DeclaredPermissions } from '../security/index.ts';
import type { RegistryEntry } from '../webmcp/index.ts';
import type { OwnershipRecord } from './ownership.ts';

// The derived tool listing: computed on every request, returned, and discarded.
//
// **The direction of this walk is the invariant.** It iterates the REGISTRY and asks the ownership
// record about each name. Inverting it — iterating the record and looking each name up in the registry
// — produces the same answer in every ordinary case and is the single most plausible refactor someone
// makes for clarity. What it silently changes is which side is the authority:
//
//   - A foreign entry stops being *excluded* and starts being *unreachable by construction*, so the
//     exclusion is no longer a decision this code makes and no longer a decision a test can break.
//   - A diverged entry stops being excluded at all: the record holds it, so the inverted walk lists a
//     tool that is not in the registry, and the agent is told about something it cannot call.
//
// Both still look correct until the two sides disagree, which is exactly when it matters.
//
// There is no cache here and no operation that invalidates one. That is not an oversight to be
// optimised later: a cached listing is a second answer to a question the registry already answers, and
// the invalidation bug that follows is silent — the agent's picture of the page goes stale and nothing
// says so. The MCP SDK re-invokes the list handler on every request, so nothing is fighting this.

/**
 * The shape MCP requires of a tool's input schema: an object schema.
 *
 * `type: 'object'` is not a default this module chose — the protocol admits nothing else for tool
 * arguments, so it is stated in the type rather than validated at runtime. Validating a declared
 * schema belongs to the runtime's own validation step; doing it here would be a gate in a
 * translation layer.
 */
export type ToolInputSchema = { type: 'object'; [key: string]: unknown };

/** One tool as the agent sees it. */
export interface ListedTool {
  readonly name: string;
  /** The human-readable name, when the application declared one. Absent when it did not. */
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  /**
   * What the tool promises to return, when it declared it.
   *
   * **This is the only way an output schema reaches an agent.** The document registry's descriptor has
   * no such field, so unlike the input schema it cannot come from the registry entry — it comes from
   * the ownership record, which is where the declaration is held.
   */
  readonly outputSchema?: Record<string, unknown>;
}

/**
 * The fields of a declaration that the listing reproduces.
 *
 * Read from what the APPLICATION declared rather than from the registry entry, and the difference
 * matters for `title`: the registry substitutes the tool's name when no title was declared, so
 * echoing its value back would publish a title the application never wrote and leave no way to tell
 * a real one from the substitute. Existence stays the registry's answer; these two fields are the
 * application's, which is the same split the input schema has always used.
 */
export interface DeclaredFields {
  readonly title?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  /**
   * What the application declared about reaching this tool.
   *
   * Read here so the exclusion happens **while walking**, not in a pass over the result — see the
   * walk's own comment. It is the same value the invocation gate reads, through the same decision
   * function, which is what stops a tool being listed and refused for reasons that disagree.
   */
  readonly permissions?: DeclaredPermissions;
}

/**
 * The built-ins' contribution to a listing.
 *
 * Two fields rather than one list, because "which names belong to this library" and "which of them
 * this connection may see" are different questions with different answers, and collapsing them
 * produces a real defect: a foreign script that registered `dom.click` while `dom` is withheld would
 * have its entry appear in the listing under a name this library owns, and the agent would call it
 * believing it had reached a gated tool.
 */
export interface BuiltInListing {
  /**
   * Every built-in name, admitted or not — the names the registry walk must never produce.
   *
   * The namespace belongs to this library whether or not the connection may reach it.
   */
  readonly claimed: ReadonlySet<string>;
  /** The built-ins this connection may currently reach. These, and only these, are listed. */
  readonly admitted: readonly ListedTool[];
}

/** What a listing produced, alongside anything unexpected noticed while producing it. */
export interface DerivedListing {
  readonly tools: readonly ListedTool[];
  /**
   * Names the ownership record holds that the registry does not.
   *
   * Carried out rather than reported from here, because this function performs no I/O and decides
   * nothing about how an alarm travels. The caller reports them.
   */
  readonly diverged: readonly string[];
}

/**
 * Derives the listing from what the registry currently holds, intersected with what this library
 * registered.
 *
 * Three exclusions, and they are **not** the same event:
 *
 * - **A name this library's own built-in table claims** — excluded from the registry walk entirely,
 *   whoever registered it. A built-in appears once, from its own table, and a foreign entry sharing
 *   its name appears not at all. Silent: a page carrying a script that registers `dom.click`
 *   is doing something legal, and it is refused at the bridge rather than reported as an anomaly.
 *
 * - **Declared unavailable by the application** — excluded, silently, and refused at invocation too.
 *   The exclusion is NOT the control — absence from a listing never refuses anything, and an agent
 *   holding a listing from a moment ago would otherwise reach a tool the application has closed. It
 *   exists so the agent's picture of the page matches what it can do, which is the difference between
 *   a model that waits and one that guesses.
 *
 * - **In the registry, not in the record** — foreign. Another script registered it. This is the normal
 *   condition of a registry shared with every script in the document, so it is excluded silently. It
 *   is still refused at invocation, because absence from a listing is not an access control.
 *
 *   **"In the document" understates where a foreign entry can come from, and the difference was
 *   measured against a real implementation.** Registration is per-document, but ENUMERATION is not:
 *   `getTools()` walks the traversable navigable's *inclusive descendant navigables* — the whole frame
 *   tree — and returns tools from every document in it that is same-origin with the caller. Confirmed
 *   on Chromium 151 (`tests/e2e/native-registry/`): a tool registered inside a same-origin iframe
 *   appears in the parent's enumeration. So an entry here may come from another script in this
 *   document OR from a child document.
 *
 *   A native listing even says which, and this is NORMATIVE rather than a Chromium extension: the
 *   draft's `RegisteredTool` — what an enumeration RETURNS — declares required `window` and `origin`
 *   members. They are absent from `ModelContextTool` only because that type is the registration
 *   INPUT. **Nothing here reads them, deliberately** — see below.
 *
 *   **The exclusion is unchanged and still correct**, because it is keyed on the ownership record
 *   rather than on where an entry came from: this library did not register it, so it is not bridged
 *   — a tool this library did not register is neither listed to nor invokable by the agent
 *   (`docs/design.md#security-invariants`). What changes is only the size of the set that reaches this
 *   line — and a reader reasoning from the narrower statement would underestimate what `enumerate()`
 *   can return.
 *
 *   **Do not "improve" this by filtering on the entry's `origin` instead.** It would pass every test
 *   here and it inverts the authority: the question this line answers is "did WE register it", and an
 *   origin can only answer "was it registered nearby". A tool another script registered in this very
 *   document has this document's origin, so an origin filter would bridge it.
 * - **In the record, not in the registry** — diverged. We believe we registered something that is not
 *   there. That is a broken invariant, so it is excluded AND reported.
 *
 * Reporting the first would fire constantly on any page carrying another script that registers tools.
 */
export function deriveListing(
  registryEntries: readonly RegistryEntry[],
  ownership: OwnershipRecord,
  declaredBy: (name: string) => DeclaredFields | undefined,
  builtIns: BuiltInListing,
): DerivedListing {
  // Built-ins first, from their own table — the one place they exist. They are never in the registry,
  // in any configuration, so the walk below cannot produce them and a listing assembled only from the
  // walk would omit every Level 2 and Level 3 tool a connection is entitled to see.
  const tools: ListedTool[] = [...builtIns.admitted];
  const seenInRegistry = new Set<string>();

  for (const entry of registryEntries) {
    seenInRegistry.add(entry.name);
    // The name is this library's, whoever put this entry in the document. Excluded before ownership is
    // consulted, so an application that managed to register a reserved name cannot produce a duplicate
    // either — a name appears once, and it means the built-in.
    if (builtIns.claimed.has(entry.name)) continue;
    if (!ownership.holds(entry.name)) continue; // Foreign. Excluded, silently and by design.
    const declared = declaredBy(entry.name);
    // **Applied HERE, inside the walk, and that placement is the invariant.** A second pass that
    // filtered the finished list would read the ownership record on its own terms — and the direction
    // of this walk is what keeps the registry the authority on existence. It would also drift: the
    // filter and the walk would be two places that decide what an agent sees.
    if (!admitsAvailability(declared?.permissions).admitted) continue;
    tools.push({
      name: entry.name,
      // Conditional spread rather than an unconditional key: an optional field that is present and
      // `undefined` is not the same as absent, and the protocol layer serializes the former.
      ...(declared?.title === undefined ? {} : { title: declared.title }),
      ...(declared?.outputSchema === undefined ? {} : { outputSchema: declared.outputSchema }),
      description: entry.description,
      // Spread first, `type` last: a tool that declared no schema accepts an object with no
      // properties, and one that declared a schema cannot override the object-ness the protocol
      // requires.
      inputSchema: { properties: {}, ...declared?.inputSchema, type: 'object' },
    });
  }

  // The other direction: names we recorded that the registry does not have. Asked of the record with
  // the registry's own answer as the argument, which is what keeps the registry the authority — the
  // record can only report a difference from a listing it was handed, never produce a listing.
  return { tools, diverged: ownership.divergedFrom(seenInRegistry) };
}
