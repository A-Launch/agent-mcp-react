import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The chat page's dev server, on the next free port in the `:450xx` block.
//
// `strictPort` for the same reason the dashboard uses it: a server that silently moved to :45021 would
// leave the operator looking at a page the documented commands do not describe.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 45020,
    strictPort: true,
  },
});
