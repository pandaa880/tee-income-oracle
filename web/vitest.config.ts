import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// No Tailwind plugin here: tests assert behaviour, not compiled CSS.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    css: false,
  },
});
