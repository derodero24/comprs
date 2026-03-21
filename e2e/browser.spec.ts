import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__ready === true, { timeout: 30_000 });
  const error = await page.evaluate(() => window.__error);
  if (error) {
    throw new Error(`Browser test harness failed: ${error}`);
  }
});

test('zstd round-trip', async ({ page }) => {
  const result = await page.evaluate(() => window.__results.zstdRoundTrip);
  expect(result).toBe(true);
});

test('gzip round-trip', async ({ page }) => {
  const result = await page.evaluate(() => window.__results.gzipRoundTrip);
  expect(result).toBe(true);
});

test('deflate round-trip', async ({ page }) => {
  const result = await page.evaluate(() => window.__results.deflateRoundTrip);
  expect(result).toBe(true);
});

test('brotli round-trip', async ({ page }) => {
  const result = await page.evaluate(() => window.__results.brotliRoundTrip);
  expect(result).toBe(true);
});

test('auto-detect decompression', async ({ page }) => {
  const result = await page.evaluate(() => window.__results.autoDetect);
  expect(result).toBe(true);
});

test('version returns string', async ({ page }) => {
  const version = await page.evaluate(() => window.__results.version);
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
});

test('streaming compression', async ({ page }) => {
  const result = await page.evaluate(() => window.__results.streaming);
  const error = await page.evaluate(() => window.__results.streamingError);
  expect(result, error || 'streaming failed').toBe(true);
});

test('streaming decompression', async ({ page }) => {
  const result = await page.evaluate(() => window.__results.streamingDecompress);
  const error = await page.evaluate(() => window.__results.streamingDecompressError);
  expect(result, error || 'streaming decompression failed').toBe(true);
});
