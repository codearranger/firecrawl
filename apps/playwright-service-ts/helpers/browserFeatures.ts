/**
 * Self-hosted replacements for fire-engine browser features: screenshots,
 * page actions, mobile emulation and location (locale/timezone/geolocation)
 * emulation. Everything here runs on stock Playwright/Chromium.
 */
import { devices, type BrowserContextOptions, type Page } from 'playwright';

export type ScreenshotOptions = {
  fullPage?: boolean;
  quality?: number;
  viewport?: { width: number; height: number };
};

export type BrowserAction =
  | { type: 'wait'; milliseconds?: number; selector?: string }
  | { type: 'click'; selector: string; all?: boolean }
  | ({ type: 'screenshot' } & ScreenshotOptions)
  | { type: 'write'; text: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; direction?: 'up' | 'down'; selector?: string }
  | { type: 'scrape' }
  | { type: 'executeJavascript'; script: string }
  | {
      type: 'pdf';
      landscape?: boolean;
      scale?: number;
      format?: string;
    };

export type LocationOptions = {
  country?: string;
  languages?: string[];
};

export type ActionResults = {
  screenshots: string[];
  scrapes: { url: string; html: string }[];
  javascriptReturns: { type: string; value: unknown }[];
  pdfs: string[];
};

type CountryProfile = {
  timezoneId: string;
  locale: string;
  latitude: number;
  longitude: number;
};

// Capital-city coordinates, primary timezone and locale. Countries not listed
// fall back to a locale derived from the country code and the US profile's
// timezone/coordinates are not applied (only locale changes).
const COUNTRY_PROFILES: Record<string, CountryProfile> = {
  US: { timezoneId: 'America/New_York', locale: 'en-US', latitude: 38.9072, longitude: -77.0369 },
  CA: { timezoneId: 'America/Toronto', locale: 'en-CA', latitude: 45.4215, longitude: -75.6972 },
  MX: { timezoneId: 'America/Mexico_City', locale: 'es-MX', latitude: 19.4326, longitude: -99.1332 },
  BR: { timezoneId: 'America/Sao_Paulo', locale: 'pt-BR', latitude: -15.7975, longitude: -47.8919 },
  AR: { timezoneId: 'America/Argentina/Buenos_Aires', locale: 'es-AR', latitude: -34.6037, longitude: -58.3816 },
  CL: { timezoneId: 'America/Santiago', locale: 'es-CL', latitude: -33.4489, longitude: -70.6693 },
  CO: { timezoneId: 'America/Bogota', locale: 'es-CO', latitude: 4.711, longitude: -74.0721 },
  GB: { timezoneId: 'Europe/London', locale: 'en-GB', latitude: 51.5072, longitude: -0.1276 },
  IE: { timezoneId: 'Europe/Dublin', locale: 'en-IE', latitude: 53.3498, longitude: -6.2603 },
  FR: { timezoneId: 'Europe/Paris', locale: 'fr-FR', latitude: 48.8566, longitude: 2.3522 },
  DE: { timezoneId: 'Europe/Berlin', locale: 'de-DE', latitude: 52.52, longitude: 13.405 },
  NL: { timezoneId: 'Europe/Amsterdam', locale: 'nl-NL', latitude: 52.3676, longitude: 4.9041 },
  BE: { timezoneId: 'Europe/Brussels', locale: 'nl-BE', latitude: 50.8503, longitude: 4.3517 },
  ES: { timezoneId: 'Europe/Madrid', locale: 'es-ES', latitude: 40.4168, longitude: -3.7038 },
  PT: { timezoneId: 'Europe/Lisbon', locale: 'pt-PT', latitude: 38.7223, longitude: -9.1393 },
  IT: { timezoneId: 'Europe/Rome', locale: 'it-IT', latitude: 41.9028, longitude: 12.4964 },
  CH: { timezoneId: 'Europe/Zurich', locale: 'de-CH', latitude: 46.948, longitude: 7.4474 },
  AT: { timezoneId: 'Europe/Vienna', locale: 'de-AT', latitude: 48.2082, longitude: 16.3738 },
  SE: { timezoneId: 'Europe/Stockholm', locale: 'sv-SE', latitude: 59.3293, longitude: 18.0686 },
  NO: { timezoneId: 'Europe/Oslo', locale: 'nb-NO', latitude: 59.9139, longitude: 10.7522 },
  DK: { timezoneId: 'Europe/Copenhagen', locale: 'da-DK', latitude: 55.6761, longitude: 12.5683 },
  FI: { timezoneId: 'Europe/Helsinki', locale: 'fi-FI', latitude: 60.1699, longitude: 24.9384 },
  PL: { timezoneId: 'Europe/Warsaw', locale: 'pl-PL', latitude: 52.2297, longitude: 21.0122 },
  CZ: { timezoneId: 'Europe/Prague', locale: 'cs-CZ', latitude: 50.0755, longitude: 14.4378 },
  UA: { timezoneId: 'Europe/Kyiv', locale: 'uk-UA', latitude: 50.4501, longitude: 30.5234 },
  RU: { timezoneId: 'Europe/Moscow', locale: 'ru-RU', latitude: 55.7558, longitude: 37.6173 },
  TR: { timezoneId: 'Europe/Istanbul', locale: 'tr-TR', latitude: 39.9334, longitude: 32.8597 },
  GR: { timezoneId: 'Europe/Athens', locale: 'el-GR', latitude: 37.9838, longitude: 23.7275 },
  IL: { timezoneId: 'Asia/Jerusalem', locale: 'he-IL', latitude: 31.7683, longitude: 35.2137 },
  AE: { timezoneId: 'Asia/Dubai', locale: 'ar-AE', latitude: 24.4539, longitude: 54.3773 },
  SA: { timezoneId: 'Asia/Riyadh', locale: 'ar-SA', latitude: 24.7136, longitude: 46.6753 },
  EG: { timezoneId: 'Africa/Cairo', locale: 'ar-EG', latitude: 30.0444, longitude: 31.2357 },
  ZA: { timezoneId: 'Africa/Johannesburg', locale: 'en-ZA', latitude: -25.7479, longitude: 28.2293 },
  NG: { timezoneId: 'Africa/Lagos', locale: 'en-NG', latitude: 9.0765, longitude: 7.3986 },
  KE: { timezoneId: 'Africa/Nairobi', locale: 'en-KE', latitude: -1.2921, longitude: 36.8219 },
  IN: { timezoneId: 'Asia/Kolkata', locale: 'en-IN', latitude: 28.6139, longitude: 77.209 },
  PK: { timezoneId: 'Asia/Karachi', locale: 'en-PK', latitude: 33.6844, longitude: 73.0479 },
  CN: { timezoneId: 'Asia/Shanghai', locale: 'zh-CN', latitude: 39.9042, longitude: 116.4074 },
  HK: { timezoneId: 'Asia/Hong_Kong', locale: 'zh-HK', latitude: 22.3193, longitude: 114.1694 },
  TW: { timezoneId: 'Asia/Taipei', locale: 'zh-TW', latitude: 25.033, longitude: 121.5654 },
  JP: { timezoneId: 'Asia/Tokyo', locale: 'ja-JP', latitude: 35.6762, longitude: 139.6503 },
  KR: { timezoneId: 'Asia/Seoul', locale: 'ko-KR', latitude: 37.5665, longitude: 126.978 },
  SG: { timezoneId: 'Asia/Singapore', locale: 'en-SG', latitude: 1.3521, longitude: 103.8198 },
  MY: { timezoneId: 'Asia/Kuala_Lumpur', locale: 'ms-MY', latitude: 3.139, longitude: 101.6869 },
  TH: { timezoneId: 'Asia/Bangkok', locale: 'th-TH', latitude: 13.7563, longitude: 100.5018 },
  VN: { timezoneId: 'Asia/Ho_Chi_Minh', locale: 'vi-VN', latitude: 21.0278, longitude: 105.8342 },
  ID: { timezoneId: 'Asia/Jakarta', locale: 'id-ID', latitude: -6.2088, longitude: 106.8456 },
  PH: { timezoneId: 'Asia/Manila', locale: 'en-PH', latitude: 14.5995, longitude: 120.9842 },
  AU: { timezoneId: 'Australia/Sydney', locale: 'en-AU', latitude: -35.2809, longitude: 149.13 },
  NZ: { timezoneId: 'Pacific/Auckland', locale: 'en-NZ', latitude: -41.2865, longitude: 174.7762 },
};

/**
 * Build the context options for mobile and location emulation. Returns an
 * empty object when neither is requested, so the caller's defaults apply.
 */
export function buildEmulationOptions(
  mobile: boolean,
  location: LocationOptions | undefined,
): Partial<BrowserContextOptions> {
  const options: Partial<BrowserContextOptions> = {};

  if (mobile) {
    const device = devices['Pixel 7'];
    Object.assign(options, {
      userAgent: device.userAgent,
      viewport: device.viewport,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
    });
  }

  const rawCountry = location?.country?.toUpperCase();
  const country =
    rawCountry && !rawCountry.startsWith('US-') ? rawCountry : undefined;
  const languages = location?.languages?.filter(Boolean) ?? [];

  if (country || languages.length > 0) {
    const profile = country ? COUNTRY_PROFILES[country] : undefined;
    const locale =
      languages[0] ?? profile?.locale ?? (country ? `en-${country}` : 'en-US');
    options.locale = locale;
    if (profile) {
      options.timezoneId = profile.timezoneId;
      options.geolocation = {
        latitude: profile.latitude,
        longitude: profile.longitude,
        accuracy: 100,
      };
      options.permissions = ['geolocation'];
    }
    const acceptLanguage = (languages.length > 0 ? languages : [locale])
      .map((lang, i) => (i === 0 ? lang : `${lang};q=${(1 - i * 0.1).toFixed(1)}`))
      .join(',');
    options.extraHTTPHeaders = { 'Accept-Language': acceptLanguage };
  }

  return options;
}

export async function takeScreenshot(
  page: Page,
  opts: ScreenshotOptions = {},
): Promise<string> {
  if (opts.viewport) {
    await page.setViewportSize(opts.viewport);
  }
  const useJpeg = opts.quality !== undefined;
  const buffer = await page.screenshot({
    fullPage: !!opts.fullPage,
    type: useJpeg ? 'jpeg' : 'png',
    ...(useJpeg ? { quality: opts.quality } : {}),
    timeout: 30000,
  });
  return `data:image/${useJpeg ? 'jpeg' : 'png'};base64,${buffer.toString('base64')}`;
}

/** Normalize a value returned from page.evaluate into Firecrawl's shape. */
function toJavascriptReturn(value: unknown): { type: string; value: unknown } {
  if (value === null) return { type: 'null', value: null };
  if (Array.isArray(value)) return { type: 'array', value };
  return { type: typeof value, value };
}

const ACTION_TIMEOUT_MS = 30000;

/**
 * Execute Firecrawl page actions in order. Screenshots (including the final
 * format screenshot, if the caller requests one afterwards) are returned as
 * data: URLs since self-hosted deployments have no media bucket.
 */
export async function runActions(
  page: Page,
  actions: BrowserAction[],
): Promise<ActionResults> {
  const results: ActionResults = {
    screenshots: [],
    scrapes: [],
    javascriptReturns: [],
    pdfs: [],
  };

  for (const [index, action] of actions.entries()) {
    try {
      await runAction(page, action, results);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ActionError(
        `Action ${index + 1} (${action.type}) failed: ${message.split('\n')[0]}`,
      );
    }
  }

  return results;
}

export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

async function runAction(
  page: Page,
  action: BrowserAction,
  results: ActionResults,
): Promise<void> {
  {
    switch (action.type) {
      case 'wait':
        if (action.selector) {
          await page.waitForSelector(action.selector, {
            timeout: ACTION_TIMEOUT_MS,
          });
        } else {
          await page.waitForTimeout(action.milliseconds ?? 1000);
        }
        break;
      case 'click':
        if (action.all) {
          const handles = await page.locator(action.selector).all();
          for (const handle of handles) {
            await handle.click({ timeout: ACTION_TIMEOUT_MS });
          }
        } else {
          await page
            .locator(action.selector)
            .first()
            .click({ timeout: ACTION_TIMEOUT_MS });
        }
        // Give navigation or client-side rendering a chance to settle.
        await page
          .waitForLoadState('domcontentloaded', { timeout: 5000 })
          .catch(() => undefined);
        break;
      case 'write':
        await page.keyboard.type(action.text, { delay: 20 });
        break;
      case 'press':
        await page.keyboard.press(action.key);
        break;
      case 'scroll': {
        const direction = action.direction === 'up' ? -1 : 1;
        if (action.selector) {
          await page
            .locator(action.selector)
            .first()
            .evaluate((el, dir) => {
              el.scrollBy(0, dir * el.clientHeight);
            }, direction);
        } else {
          await page.mouse.wheel(0, direction * 1000);
        }
        await page.waitForTimeout(300);
        break;
      }
      case 'screenshot':
        results.screenshots.push(await takeScreenshot(page, action));
        break;
      case 'scrape':
        results.scrapes.push({ url: page.url(), html: await page.content() });
        break;
      case 'executeJavascript': {
        // Run as the body of an async function so `return` works the way
        // Firecrawl's docs describe. A string expression is evaluated over
        // CDP, so it is not blocked by a page's Content-Security-Policy the
        // way `new Function` inside the page would be.
        const value = await page.evaluate(
          `(async () => { ${action.script}\n })()`,
        );
        results.javascriptReturns.push(toJavascriptReturn(value));
        break;
      }
      case 'pdf': {
        const buffer = await page.pdf({
          landscape: !!action.landscape,
          scale: action.scale ?? 1,
          format: action.format ?? 'Letter',
          printBackground: true,
        });
        results.pdfs.push(
          `data:application/pdf;base64,${buffer.toString('base64')}`,
        );
        break;
      }
      default:
        throw new Error(
          `Unsupported action type: ${(action as { type: string }).type}`,
        );
    }
  }
}
