import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Read only the explicit public key alias; never expose SIGNAL_API_KEY or
  // broaden Vite's envPrefix to SIGNAL_, which would publish the server secret.
  const env = loadEnv(mode, process.cwd(), ['VITE_ANALYTICS_', 'SIGNAL_API_KEY_FRONTEND']);
  const browserKey = env.VITE_ANALYTICS_KEY || env.SIGNAL_API_KEY_FRONTEND || '';
  if (browserKey.trim() && !/^pk_[A-Za-z0-9_-]+$/.test(browserKey)) {
    throw new Error('Browser analytics requires a public pk_ key. Remove private credentials from VITE_ANALYTICS_KEY / SIGNAL_API_KEY_FRONTEND.');
  }
  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_ANALYTICS_KEY': JSON.stringify(browserKey),
      'import.meta.env.VITE_ANALYTICS_URL': JSON.stringify(env.VITE_ANALYTICS_URL || ''),
    },
    build: { outDir: 'dist/client' },
  };
});
