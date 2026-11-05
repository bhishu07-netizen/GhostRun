import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  // The Privacy and Terms pages print this address. Refuse to build without it so
  // the site can never go live with a blank contact.
  const env = loadEnv(mode, process.cwd());
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.VITE_CONTACT_EMAIL || '')) {
    throw new Error('Set VITE_CONTACT_EMAIL in .env to the Ghostrun contact address before building.');
  }
  return {
    appType: 'mpa',
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          privacy: resolve(__dirname, 'privacy.html'),
          terms: resolve(__dirname, 'terms.html'),
        },
      },
    },
  };
});
