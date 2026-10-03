import { defineConfig } from '@playwright/test';

/** Port of browser/server.mjs, which serves the bundles that browser/build.mjs writes. */
export const STATIC_PORT = 4567;

/** Port of the Vite dev server, which serves browser/index.html. */
export const VITE_DEV_PORT = 4568;

export default defineConfig({
  testMatch: 'browser.spec.ts',
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: [
    {
      command: `node browser/server.mjs ${STATIC_PORT}`,
      url: `http://localhost:${STATIC_PORT}/browser/index.html`,
      reuseExistingServer: !process.env.CI,
    },
    {
      // --force: the dependency cache of Vite does not notice that
      // install-package.mjs replaced the package.
      command: `vite browser --port ${VITE_DEV_PORT} --strictPort --force`,
      url: `http://localhost:${VITE_DEV_PORT}/`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
