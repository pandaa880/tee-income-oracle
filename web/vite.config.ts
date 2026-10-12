import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/** The deployed gateway; local dev reaches it through `/gw`, so its CORS origin can stay Vercel. */
const DEFAULT_GATEWAY = 'https://gateway.wonderfulcliff-e3927235.uaenorth.azurecontainerapps.io';

export default defineConfig(({ mode }) => {
  // GATEWAY_PROXY_TARGET has no VITE_ prefix: it configures the dev server and never ships.
  const target = loadEnv(mode, process.cwd(), '').GATEWAY_PROXY_TARGET ?? DEFAULT_GATEWAY;
  return {
    plugins: [react(), tailwindcss()],
    // main.tsx awaits the demo wallet before the first render (top-level await).
    build: { target: 'es2022' },
    server: {
      proxy: {
        '/gw': {
          target,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/gw/, ''),
        },
      },
    },
  };
});
