import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmulationOptions } from './browserFeatures';

test('no emulation requested returns no overrides', () => {
  assert.deepEqual(buildEmulationOptions(false, undefined), {});
});

test('mobile emulation sets a touch-capable mobile device', () => {
  const opts = buildEmulationOptions(true, undefined);
  assert.equal(opts.isMobile, true);
  assert.equal(opts.hasTouch, true);
  assert.match(String(opts.userAgent), /Mobile/);
  assert.ok((opts.viewport as { width: number }).width < 600);
});

test('known country sets locale, timezone and geolocation', () => {
  const opts = buildEmulationOptions(false, { country: 'jp' });
  assert.equal(opts.locale, 'ja-JP');
  assert.equal(opts.timezoneId, 'Asia/Tokyo');
  assert.deepEqual(opts.permissions, ['geolocation']);
  assert.equal(opts.extraHTTPHeaders?.['Accept-Language'], 'ja-JP');
});

test('explicit languages win and build a weighted Accept-Language', () => {
  const opts = buildEmulationOptions(false, {
    country: 'CH',
    languages: ['fr-CH', 'de-CH'],
  });
  assert.equal(opts.locale, 'fr-CH');
  assert.equal(opts.timezoneId, 'Europe/Zurich');
  assert.equal(opts.extraHTTPHeaders?.['Accept-Language'], 'fr-CH,de-CH;q=0.9');
});

test('Firecrawl default "us-generic" country does not override anything', () => {
  assert.deepEqual(buildEmulationOptions(false, { country: 'us-generic' }), {});
});

test('unknown country only sets a locale', () => {
  const opts = buildEmulationOptions(false, { country: 'IS' });
  assert.equal(opts.locale, 'en-IS');
  assert.equal(opts.timezoneId, undefined);
});
