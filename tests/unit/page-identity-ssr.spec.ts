import { describe, expect, it } from 'vitest';
import {
  IDENTITY_UNAVAILABLE,
  PageIdentityError,
  pageInstanceId,
} from '../../src/page-identity.ts';

// The page identity on a server, where there is no page instance to identify.
//
// Its own file because the environment is the subject: the `unit` project runs in `node`, and the
// sibling identity suite opts into jsdom with a docblock. A case asserting "no document" cannot live
// in a file that has one, and running both under one environment would let the version that passes
// hide the one that matters.
//
// **This is a normal path, not a failure to design around.** The provider resolves nothing at module
// scope and does its work in an effect, so a server render is expected rather than guarded against
// (`docs/design.md#the-provider`). An identity names a browser page
// instance. A server render has none, so it is told so rather than handed a value — a fallback here
// would flow into a connection URL and identify something that does not exist.

describe('a page identity on a server', () => {
  it('has no document to work with, which is the condition under test', () => {
    // Stated rather than assumed. If a future config gave this project a DOM, every case below would
    // pass for the wrong reason and this one would fail loudly instead.
    expect(typeof document).toBe('undefined');
  });

  it('refuses, and says there is no page instance rather than blaming the environment', () => {
    try {
      pageInstanceId();
      expect.unreachable('a server render has no page instance to identify');
    } catch (error) {
      expect(error).toBeInstanceOf(PageIdentityError);
      // `noDocument` and NOT `noUniqueSource`, which is the distinction that matters: Node has a
      // cryptographic source, so a check written against the source alone would happily mint an
      // identity on the server for a page that does not exist.
      expect((error as PageIdentityError).code).toBe(IDENTITY_UNAVAILABLE.noDocument);
    }
  });

  it('is not reached by importing the package', async () => {
    // The library never reads an identity while rendering. It needs one only when the
    // application dials, which happens in an effect. If module evaluation or a provider render read
    // one, server rendering would throw — so this is the case that keeps the refusal above safe.
    const module = await import('../../src/index.ts');
    expect(typeof module.AgentMcpProvider).toBe('function');
  });
});
