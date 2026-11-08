import { z } from "zod";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { robustFetch } from "../../lib/fetch";
import { getInnerJson } from "@mendable/firecrawl-rs";
import { hasFormatOfType } from "../../../../lib/format-utils";
import { calculateTotalWaitTime } from "../../../../controllers/v2/types";

const actionResultsSchema = z.object({
  screenshots: z.array(z.string()),
  scrapes: z.array(z.object({ url: z.string(), html: z.string() })),
  javascriptReturns: z.array(
    z.object({ type: z.string(), value: z.unknown() }),
  ),
  pdfs: z.array(z.string()),
});

/**
 * Request fields understood by playwright-service builds that ship
 * helpers/browserFeatures.ts. Only sent when PLAYWRIGHT_EXTENDED_FEATURES is
 * on, so older services never see unknown fields.
 */
function extendedRequestFields(meta: Meta) {
  if (!config.PLAYWRIGHT_EXTENDED_FEATURES) return {};
  const screenshotFormat = hasFormatOfType(meta.options.formats, "screenshot");
  const actions = meta.options.actions ?? [];
  return {
    ...(screenshotFormat
      ? {
          screenshot: {
            fullPage: !!screenshotFormat.fullPage,
            ...(screenshotFormat.quality !== undefined
              ? { quality: screenshotFormat.quality }
              : {}),
            ...(screenshotFormat.viewport
              ? { viewport: screenshotFormat.viewport }
              : {}),
          },
        }
      : {}),
    ...(actions.length > 0 ? { actions } : {}),
    ...(meta.options.mobile ? { mobile: true } : {}),
    ...(meta.options.location ? { location: meta.options.location } : {}),
  };
}

export async function scrapeURLWithPlaywright(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const response = await robustFetch({
    url: config.PLAYWRIGHT_MICROSERVICE_URL!,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      url: meta.rewrittenUrl ?? meta.url,
      wait_after_load: meta.options.waitFor,
      timeout: meta.abort.scrapeTimeout(),
      headers: meta.options.headers,
      skip_tls_verification: meta.options.skipTlsVerification,
      ...extendedRequestFields(meta),
    },
    method: "POST",
    logger: meta.logger.child("scrapeURLWithPlaywright/robustFetch"),
    schema: z.object({
      content: z.string(),
      pageStatusCode: z.number(),
      pageError: z.string().optional(),
      contentType: z.string().optional(),
      // Optional: older playwright-service builds don't send it.
      url: z.string().optional(),
      screenshot: z.string().optional(),
      actions: actionResultsSchema.optional(),
    }),
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  if (response.contentType?.includes("application/json")) {
    response.content = await getInnerJson(response.content);
  }

  return {
    // The landed URL reported by the service. Redirect threat and blocklist
    // re-checks compare it against the requested URL. Falls back to the
    // requested URL for older services or a non-http(s) value (about:blank).
    url: landedHttpUrl(response.url) ?? meta.rewrittenUrl ?? meta.url,
    html: response.content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,
    screenshot: response.screenshot,
    ...(response.actions ? { actions: response.actions } : {}),

    proxyUsed: "basic",
  };
}

function landedHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function playwrightMaxReasonableTime(meta: Meta): number {
  const actionTime = config.PLAYWRIGHT_EXTENDED_FEATURES
    ? calculateTotalWaitTime(meta.options.actions ?? []) +
      (meta.options.actions?.length ?? 0) * 2000
    : 0;
  return (meta.options.waitFor ?? 0) + actionTime + 30000;
}
