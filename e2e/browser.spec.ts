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

test('lz4 round-trip', async ({ page }) => {
  const result = await page.evaluate(() => window.__results.lz4RoundTrip);
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

test('crc32 returns number', async ({ page }) => {
  const crc = await page.evaluate(() => window.__results.crc32);
  expect(typeof crc).toBe('number');
});

test('detect format', async ({ page }) => {
  const format = await page.evaluate(() => window.__results.detectFormat);
  expect(format).toBe('zstd');
});
