import type { Fetcher, Watch } from "../src/types";

/** Hand-built fixtures modelled on the observed checkout flow. No HAR data. */

export const WATCH: Watch = {
  id: "test-watch",
  name: "Test Controller",
  sku: "SKU-TEST-E000",
  productId: "SKU-TEST",
  productUrl: "https://www.playstation.com/en-gb/test-product/",
  clientId: "client-123",
};

export const PAD_BYTES = 300_000;

export function nextDataPage(reason: string | null, padTo = PAD_BYTES): string {
  const pageProps: Record<string, unknown> = { query: { skuId: WATCH.sku, upSellService: "NONE" } };
  if (reason !== null) pageProps.reason = reason;
  const head =
    `<!DOCTYPE html><html><head><title>Error | Checkout</title></head><body><div id="__next"></div>` +
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script>`;
  return head + "<!--" + "x".repeat(Math.max(0, padTo - head.length)) + "--></body></html>";
}

export function checkoutPage(padTo = PAD_BYTES): string {
  const head = `<!DOCTYPE html><html><head><title>Checkout</title></head><body><div id="__next">Review your order</div>`;
  return head + "<!--" + "x".repeat(Math.max(0, padTo - head.length)) + "--></body></html>";
}

export function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

export interface MockFetch extends Fetcher {
  calls: { url: string; init?: RequestInit }[];
}

/**
 * Routes by host + pathname. Throws for anything unrouted so a test can never
 * silently hit the network.
 */
export function mockFetch(routes: Record<string, Route>): MockFetch {
  const calls: MockFetch["calls"] = [];
  const fn = (async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init });
    const url = new URL(input);
    const route = routes[`${url.host}${url.pathname}`] ?? routes[url.host];
    if (!route) throw new Error(`unrouted request: ${url.host}${url.pathname}`);
    return route(url, init);
  }) as MockFetch;
  fn.calls = calls;
  return fn;
}

const CO = "checkout.playstation.com";

/** The full observed sold-out chain: 3 redirects then /error with the given page. */
export function chainRoutes(final: Route): Record<string, Route> {
  return {
    [`${CO}/buynow/${WATCH.sku}`]: () => redirect(`/unified/buynow/${WATCH.sku}?clientId=${WATCH.clientId}`),
    [`${CO}/unified/buynow/${WATCH.sku}`]: (url) =>
      url.searchParams.has("skuId")
        ? redirect(`/error?skuId=${WATCH.sku}&upSellService=NONE&clientId=${WATCH.clientId}`)
        : redirect(`/unified/buynow/${WATCH.sku}?skuId=${WATCH.sku}&upSellService=NONE&clientId=${WATCH.clientId}`),
    [`${CO}/error`]: final,
  };
}

export function soldOutRoutes(): Record<string, Route> {
  return chainRoutes(() => html(nextDataPage("skuOutOfStock")));
}

export function ctaBody(type = "PREORDER", price = "£74.99", value = 7499) {
  return {
    data: {
      productRetrieve: {
        webctas: [{ type, action: { type: "BUY_NOW" }, meta: { ineligibilityReasons: [] }, price: { discountedPrice: price, discountedValue: value } }],
      },
    },
  };
}

export const CTA_HOST = "web.np.playstation.com";
export const TELEGRAM_HOST = "api.telegram.org";

export class MemoryKV {
  store = new Map<string, string>();
  puts = 0;
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.puts++;
    this.store.set(key, value);
  }
}
