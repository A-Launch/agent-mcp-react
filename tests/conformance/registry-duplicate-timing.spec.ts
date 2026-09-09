// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createOwnershipRecord } from '../../src/runtime/ownership.ts';
import { REGISTRATION_REFUSED } from '../../src/webmcp/errors.ts';
import { register, resetResolutionForTests } from '../../src/webmcp/registry.ts';
import { initializePortabilityLayer, resetRegistry } from './harness.ts';

// **When a duplicate name is refused, the answer differs by implementation — and both are real.**
//
// Four sources, three behaviours. The first two were read from the pinned normative text
// (`tests/conformance/evidence/webmcp-41d12f0.bs`); the third was MEASURED against
// Chromium 151 with `--enable-features=WebMCP` (`tests/e2e/native-registry/`):
//
//   the STANDARD          returns a promise REJECTED with an InvalidStateError DOMException
//                         ("If |tool map|[|tool name|] exists, then return a promise rejected with…")
//   CHROMIUM 151          REJECTS with InvalidStateError — "Duplicate tool name". Conformant.
//   the RESOLVED PACKAGE  THROWS synchronously — `Tool already registered: <name>`
//   a Feb-2026 summary    said it REPLACES. It does not, in any of the three.
//
// **So this is not a hypothetical divergence — the two implementations this library can actually run
// against settle a duplicate on DIFFERENT CHANNELS.** `src/webmcp/registry.ts` writes `try { await … }`
// and no trailing `.catch()`, which is the one spelling that catches both. A `.catch()` would be
// correct against Chromium and would let the package's throw escape as an uncaught exception.
//
// **This file owns ONE case: the rejection channel.** The synchronous-throw channel is already owned
// by `registry-registration.spec.ts` ("refuses it SYNCHRONOUSLY, which is the fact the boundary is
// shaped around"), which predates it — a second copy was added before that was noticed, and removed
// again rather than leaving two cases free to disagree about the same fact. One owner per truth.

beforeEach(async () => {
  await resetRegistry();
  await initializePortabilityLayer();
});

describe('the boundary handles the STANDARD’s behaviour too', () => {
  it('catches a rejected promise, and classifies it as a contested name', async () => {
    // **The normative path, driven directly.** No engine in this matrix rejects a duplicate through
    // the portability layer — Chromium's native registry does, measured in
    // `tests/e2e/native-registry/`, but the layer this project loads throws synchronously. So the
    // registry is stood in for, which is legitimate because the subject is THIS LIBRARY'S handling
    // rather than the platform's behaviour.
    //
    // Without this case, "try { await } also catches a rejection" is a claim about JavaScript rather
    // than an assertion about this code, and a refactor to `.catch()` would pass every other case
    // while breaking against the package this project actually runs.
    //
    // **THE STUB MUST REPLACE BOTH HOSTS, and this is the whole reason the case is written this way.**
    // The first version defined `document.modelContext` only. The portability layer had just installed
    // itself on `document` AND `navigator`, so the two hosts then pointed at different registries, and
    // `ensureRegistry()` refused with `MCP_REGISTRY_HOSTS_DIVERGED` *before* reaching the stub. The
    // case passed on that rejection — `.rejects.toBeDefined()` cannot tell one rejection from another
    // — and the stub was never called once. Measured, not theorised: a probe printed
    // `stubCalled = false` against a green case.
    //
    // That is why the two assertions below are not decoration. `stubCalled` proves the rejection came
    // from the registry rather than from the resolution step, and the failure code proves the boundary
    // CLASSIFIED it rather than merely letting it escape.
    let stubCalled = false;
    const rejecting = {
      registerTool: () => {
        stubCalled = true;
        return Promise.reject(
          Object.assign(new Error('a tool with that name is already registered'), {
            name: 'InvalidStateError',
          }),
        );
      },
    };
    for (const host of [document, navigator]) {
      Object.defineProperty(host, 'modelContext', { value: rejecting, configurable: true });
    }
    // The module caches its resolved registry; without this it would hand back the layer's instance
    // and the stub would again never be reached.
    resetResolutionForTests();

    const ownership = createOwnershipRecord();
    const controller = new AbortController();

    const failure = await register(
      {
        name: 'timing.rejecting',
        description: 'refused by rejection, as the standard specifies',
        handler: () => 'never runs',
      },
      controller.signal,
      ownership,
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(
      stubCalled,
      'the REGISTRY must be what rejected — not the resolution step before it',
    ).toBe(true);
    expect(failure, 'a rejected registration must reach the caller as a failure').toBeDefined();
    // Classified, not merely propagated. The name is not ours and the signal is live, so a rejection
    // from the registry is a foreign owner holding the name — the same verdict the synchronous throw
    // gets, which is the point: one classification, two channels.
    expect((failure as { code?: string }).code).toBe(REGISTRATION_REFUSED.nameHeldByForeignOwner);
  });
});
