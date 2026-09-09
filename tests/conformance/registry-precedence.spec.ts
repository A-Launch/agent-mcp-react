// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalRegistry,
  deprecatedHostRegistry,
  descriptorFor,
  initializePortabilityLayer,
  resetRegistry,
} from './harness.ts';

// Two rows of the conformance table (`docs/conformance.md#the-rows`): "the layer declines to install
// over a registry already at the canonical location" and "a second initialization changes nothing".
//
// **`src/webmcp/registry.ts` states this reliance in its own comment**, which is what makes it a
// conformance question rather than a unit one:
//
//   "The portability layer already declines to install over an existing registry, and duplicating
//    that rule here would create a second owner of it — so the outcome is asserted and the rule is
//    not re-implemented — one owner per truth."
//
// That is a claim about somebody else's package, and the rule for those is that a requirement MUST NOT
// be claimed against such a behaviour before its case passes (`docs/design.md#testing-strategy`).
//
// **What these cases evidence, and what they do not.** They establish that the ADOPTED LAYER declines
// to install over a registry already at the canonical location. They do NOT establish anything about
// a real native implementation. **One is reachable** — Chromium 151 under
// `--enable-features=WebMCP` — and is measured in `tests/e2e/native-registry/`, which is opt-in and
// outside the release gate. These cases are deliberately NOT moved there: what they pin is the adopted
// layer's deference, which is this library's actual reliance, and it must hold on Firefox and WebKit
// where no native registry exists at all. Recorded in `docs/conformance.md`, as the supported-browser
// matrix is in `docs/browser-support.md`.

beforeEach(async () => {
  await resetRegistry();
});

describe('the adopted layer and a registry that is already present', () => {
  it('installs one when the canonical location is empty', async () => {
    // The baseline. Without it every case below could pass against a layer that installs nothing.
    expect(canonicalRegistry()).toBeUndefined();
    await initializePortabilityLayer();
    expect(canonicalRegistry()).toBeDefined();
  });

  it('reaches the SAME object from the canonical and the deprecated host', async () => {
    // The standard's migration from the deprecated host object to the canonical one, and the
    // postcondition `src/webmcp/registry.ts` asserts (`docs/conformance.md`): "where both host objects are
    // present they resolve to the same one". Two registries reachable under two names would mean a
    // tool registered through one is invisible through the other.
    await initializePortabilityLayer();
    expect(canonicalRegistry()).toBeDefined();
    expect(deprecatedHostRegistry()).toBe(canonicalRegistry());
  });

  it('declines to install over a registry that is already there, leaving the original untouched', async () => {
    // The row itself. A stand-in is placed first, and the assertion is on OBJECT IDENTITY — an
    // "equivalent" registry would mean the layer replaced something it should have left alone, and
    // every tool registered in the original would have silently vanished.
    await initializePortabilityLayer();
    const original = canonicalRegistry();
    expect(original).toBeDefined();

    await initializePortabilityLayer();

    expect(canonicalRegistry()).toBe(original);
  });

  it('changes nothing on a second initialization, including the deprecated alias', async () => {
    // The second row. Asserted on both hosts, because a layer that left the canonical location alone
    // and re-pointed the alias would break the agreement between the two host objects that the
    // standard's migration path requires.
    await initializePortabilityLayer();
    const canonical = canonicalRegistry();
    const deprecated = deprecatedHostRegistry();

    await initializePortabilityLayer();
    await initializePortabilityLayer();

    expect(canonicalRegistry()).toBe(canonical);
    expect(deprecatedHostRegistry()).toBe(deprecated);
  });

  it('preserves tools registered before a second initialization', async () => {
    // The consequence a reader actually cares about, asserted rather than inferred from identity: if a
    // second initialization silently replaced the registry, the tools would go with it — and the
    // symptom would be an agent seeing an empty page, not an error.
    await initializePortabilityLayer();
    const registry = canonicalRegistry();
    expect(registry).toBeDefined();

    const controller = new AbortController();
    await registry?.registerTool(descriptorFor('conformance.survivor'), {
      signal: controller.signal,
    });

    await initializePortabilityLayer();

    const names = (await canonicalRegistry()?.getTools())?.map((tool) => tool.name) ?? [];
    expect(names).toContain('conformance.survivor');
  });
});
