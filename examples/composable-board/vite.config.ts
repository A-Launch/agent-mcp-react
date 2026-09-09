import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The board demonstrator's dev server. Nothing here is part of the library — it exists so an operator
// can open a real browser at the port the `:450xx` block reserves and watch a sentence become panels.
//
// `strictPort` is deliberate, for the same reason it is on the other demonstrator: a server that
// silently moved to :45031 when :45030 was taken would leave an operator looking at a page the
// documented commands do not describe, and the mock agent's logs would name a tab nobody could find.
//
// What this file deliberately does NOT carry: the CSP probe plugin. `examples/customer-dashboard` owns
// that demonstration, and a second copy would be a second thing to keep correct with no second reader.
export default defineConfig({
  plugins: [react()],
  // Vite exposes only prefixed variables to the browser and its default prefix is `VITE_`. This
  // repository names its variables `AMR_`, so without this line every one of them reads as `undefined`
  // at runtime — a knob that looks like configuration and changes nothing.
  envPrefix: 'AMR_',
  server: {
    port: 45030,
    strictPort: true,
  },
});
