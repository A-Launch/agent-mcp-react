import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Shared setup for the React layer.
//
// `cleanup` unmounts every tree a case rendered. It matters more here than in an ordinary React
// codebase: this library's central claim is that unmount withdraws a tool, so a tree left mounted
// between cases would leave registrations behind and the next case would assert against a registry
// polluted by its predecessor — passing or failing for a reason that has nothing to do with it.
afterEach(() => {
  cleanup();
});
