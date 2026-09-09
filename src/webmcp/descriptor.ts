import type { ModelContextToolInfo, ToolDescriptor } from '@mcp-b/webmcp-types';

// Translation between this project's tool declaration and the platform's descriptor shape.
//
// It exists so that no other module handles either shape. A field rename in a revision of the standard
// is absorbed here; a runtime or a React hook that reached for `descriptor.inputSchema` directly would
// turn that one-line edit into a repository-wide one — the coupling that spreads gradually and stays
// invisible until it is expensive (docs/conformance.md).
//
// This module carries only what the platform's descriptor carries. Risk level, confirmation, output
// schema and policy have no home here on purpose — the registry cannot hold them, and putting them in
// the translation would imply it could.

/**
 * A tool as this library's callers declare it: the platform's descriptor fields, and nothing else.
 *
 * `annotations` is deliberately absent from what a caller may set through this boundary. The standard's
 * annotations are hints to a caller and never enforcement, and this project derives risk from its own
 * declaration rather than from a hint — so passing them through here would create a second place risk
 * appears to come from.
 */
export interface ToolDeclaration {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** JSON Schema for the arguments. Validation happens in the runtime, before the handler runs. */
  readonly inputSchema?: Record<string, unknown>;
  /** Receives validated arguments. Its result is carried by the caller, not by the registry. */
  readonly handler: (args: Record<string, unknown>) => unknown;
}

/** What enumeration reports about one entry the registry holds, including entries we did not create. */
export interface RegistryEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The origin the registry attributes the entry to. */
  readonly origin: string;
}

/** What a tool that declares no arguments accepts: an object with no properties. */
const EMPTY_INPUT_SCHEMA = { type: 'object', properties: {} } as const;

/**
 * A descriptor complete enough to register.
 *
 * The platform's own descriptor type makes `inputSchema` optional and its registration surface is
 * overloaded on whether it is present, so a value typed as "maybe there" matches no overload cleanly.
 * This module always supplies one, and says so in the type — which is also what lets the registration
 * call be written without a cast.
 */
export type RegistrableDescriptor = ToolDescriptor & {
  inputSchema: NonNullable<ToolDescriptor['inputSchema']>;
};

/**
 * Translates a declaration into the platform's descriptor.
 *
 * The handler is passed through unwrapped. This boundary does not validate arguments, does not check
 * policy and does not shape results — a translation layer that also decided things would be a gate
 * nobody could find. Capability, registration and permission are three separate gates and all of them
 * live in the runtime.
 */
export function toDescriptor(declaration: ToolDeclaration): RegistrableDescriptor {
  // An input schema is always emitted, defaulting to "an object with no properties" when the caller
  // declared none. The registry would apply that default itself, which is exactly the reason not to
  // rely on it: a descriptor whose shape depends on a runtime default is a descriptor that changes
  // when the runtime does, and this boundary exists so that a revision of the standard is absorbed
  // here rather than felt upstream.
  const descriptor: RegistrableDescriptor = {
    name: declaration.name,
    description: declaration.description,
    inputSchema: (declaration.inputSchema ?? EMPTY_INPUT_SCHEMA) as NonNullable<
      ToolDescriptor['inputSchema']
    >,
    execute: (args: Record<string, unknown>) =>
      declaration.handler(args) as ReturnType<ToolDescriptor['execute']>,
  };
  // Assigned rather than spread conditionally: under `exactOptionalPropertyTypes` a conditional
  // spread cannot prove the key is present, and an absent optional must stay absent rather than
  // becoming present-and-undefined.
  if (declaration.title !== undefined) descriptor.title = declaration.title;
  return descriptor;
}

/**
 * Translates what the registry reports into this project's shape.
 *
 * Applied to every entry, including foreign ones. Whether an entry is ours is the caller's question,
 * answered from its ownership record — this module has no opinion and keeps no record to form one.
 */
export function fromRegistryEntry(info: ModelContextToolInfo): RegistryEntry {
  return {
    name: info.name,
    title: info.title,
    description: info.description,
    origin: info.origin,
  };
}
