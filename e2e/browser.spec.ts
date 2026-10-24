import { expect, test } from '@playwright/test';
import { STATIC_PORT, VITE_DEV_PORT } from './playwright.config.ts';

// The browser fixtures: browser/app.js, built or served as the README's
// Browser Usage section says, imports the installed package by name and
// runs the checks of scenario.js.
const FIXTURES = {
  esbuild: `http://localhost:${STATIC_PORT}/dist/esbuild/`,
  webpack: `http://localhost:${STATIC_PORT}/dist/webpack/`,
  'vite build': `http://localhost:${STATIC_PORT}/dist/vite/`,
  'vite dev': `http://localhost:${VITE_DEV_PORT}/`,
  'import map': `http://localhost:${STATIC_PORT}/browser/importmap.html`,
};

for (const [name, url] of Object.entries(FIXTURES)) {
  test(name, async ({ page }) => {
    // What goes wrong before the checks can report: the bundle or the
    // WebAssembly module fails to load, or the import throws. The glue logs
    // a warning when it gets the binary with another type than
    // application/wasm.
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(`Uncaught ${error.stack ?? error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        problems.push(`console.${message.type()}: ${message.text()}`);
      }
    });
    page.on('requestfailed', (request) => {
      problems.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        problems.push(`${response.url()}: HTTP ${response.status()}`);
      }
    });

    const navigation = await page.goto(url);
    expect(navigation?.status(), `HTTP status of ${url}`).toBe(200);
    const html = page.locator('html');
    await expect
      .poll(async () => problems.length > 0 || (await html.getAttribute('data-result')) !== null, {
        timeout: 45_000,
      })
      .toBe(true);
    expect(problems).toEqual([]);
    expect(await html.getAttribute('data-result')).toBe('passed');
  });
}
