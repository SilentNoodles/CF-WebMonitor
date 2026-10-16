import type { Fetcher, Watch } from "./types";

/**
 * Primary stock check.
 *
 * Clicking "Pre-Order" on the product page makes the browser follow a chain of
 * plain server-side redirects on checkout.playstation.com:
 *
 *   /buynow/<sku>  ->  /unified/buynow/<sku>  ->  /unified/buynow/<sku>?skuId=...
 *   ->  /error?skuId=...   (200, __NEXT_DATA__ pageProps.reason = "skuOutOfStock")
 *
 * While the item is sold out the chain always ends on /error with that reason.
 * We replay the chain without cookies and report where it lands. Anything other
 * than the known sold-out landing page is treated as "worth a look".
 */

export type Verdict =
  | "OUT_OF_STOCK" // landed on /error with reason skuOutOfStock (the expected, quiet state)
  | "AVAILABLE" // landed on a normal (non-error) checkout page
  | "CHANGED" // something different but not clearly in stock (other error reason, off-site redirect, 404...)
  | "BLOCKED" // looks like bot protection (403/429/503 or a challenge page)
  | "FAILED"; // network error, timeout, 5xx, redirect loop

export interface BuyNowResult {
  verdict: Verdict;
  detail: string;
  /** Hop-by-hop trail, e.g. "302 checkout.playstation.com/buynow/..." */
  chain: string[];
  reason?: string;
}

export const CHECKOUT_HOST = "checkout.playstation.com";
const MAX_HOPS = 8;
const TIMEOUT_MS = 10_000;
/** Real challenge pages are tiny; the genuine checkout/error pages are ~300 KB. */
const CHALLENGE_MAX_BYTES = 30_000;
const BLOCK_STATUSES = new Set([403, 429, 503]);
const BLOCK_BODY =
  /access denied|pardon our interruption|just a moment|attention required|captcha|unusual traffic|request blocked|bm-verify/i;

/**
 * Sent on every request. The Worker identifies itself honestly: no browser
 * user agent and no playstation.com referer. If the site blocks this, the
 * answer is a different signal, not a disguise.
 */
export const REQUEST_HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  "user-agent": "cf-webmonitor (personal stock check)",
};

export function buildBuyNowUrl(watch: Watch, nonce = 1000 + Math.floor(Math.random() * 9000)): string {
  const hostUrl = `${watch.productUrl}?skuId=${watch.sku}&upSellService=NONE`;
  const q = new URLSearchParams({
    clientId: watch.clientId,
    hostUrl,
    "privacy-policy": "minimal",
    nonce: String(nonce),
    locale: "en-GB",
  });
  return `https://${CHECKOUT_HOST}/buynow/${watch.sku}?${q.toString()}`;
}

/** Pull `props.pageProps.reason` out of a Next.js error page. */
export function extractReason(html: string): string | undefined {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (m?.[1]) {
    try {
      const data = JSON.parse(m[1]) as { props?: { pageProps?: { reason?: unknown } } };
      const reason = data.props?.pageProps?.reason;
      if (typeof reason === "string") return reason;
    } catch {
      /* fall through to the loose match */
    }
  }
  return html.match(/"reason":"([A-Za-z0-9_.-]{1,60})"/)?.[1];
}

export async function checkBuyNow(watch: Watch, fetcher: Fetcher = fetch): Promise<BuyNowResult> {
  let url = buildBuyNowUrl(watch);
  const chain: string[] = [];

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let res: Response;
    try {
      res = await fetcher(url, {
        redirect: "manual",
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      return { verdict: "FAILED", detail: `network error: ${errMsg(e)}`, chain };
    }

    const here = new URL(url);
    chain.push(`${res.status} ${here.host}${here.pathname}`);

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const loc = res.headers.get("location");
      if (!loc) return { verdict: "FAILED", detail: `HTTP ${res.status} without a Location header`, chain };
      const next = new URL(loc, url);
      if (next.host !== CHECKOUT_HOST) {
        return {
          verdict: "CHANGED",
          detail: `redirected off-site to ${next.host}${next.pathname}`,
          chain,
        };
      }
      url = next.toString();
      continue;
    }

    if (BLOCK_STATUSES.has(res.status)) {
      return { verdict: "BLOCKED", detail: `HTTP ${res.status}`, chain };
    }
    if (res.status >= 500) {
      return { verdict: "FAILED", detail: `HTTP ${res.status}`, chain };
    }

    const body = await res.text();
    const small = body.length < CHALLENGE_MAX_BYTES;

    if (here.pathname.startsWith("/error")) {
      const reason = extractReason(body);
      if (reason === "skuOutOfStock") {
        return { verdict: "OUT_OF_STOCK", detail: "checkout reports skuOutOfStock", chain, reason };
      }
      if (!reason && small && BLOCK_BODY.test(body)) {
        return { verdict: "BLOCKED", detail: "challenge page instead of the error page", chain };
      }
      return {
        verdict: "CHANGED",
        detail: `checkout error page with reason "${reason ?? "unknown"}"`,
        chain,
        reason,
      };
    }

    if (res.status >= 400) {
      return { verdict: "CHANGED", detail: `HTTP ${res.status} at ${here.pathname}`, chain };
    }
    if (small && BLOCK_BODY.test(body)) {
      return { verdict: "BLOCKED", detail: "challenge page", chain };
    }
    return { verdict: "AVAILABLE", detail: `landed on ${here.pathname} (HTTP ${res.status})`, chain };
  }

  return { verdict: "FAILED", detail: `more than ${MAX_HOPS} redirects`, chain };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
