import { describe, expect, it } from "vitest";
import { buildBuyNowUrl, checkBuyNow, extractReason } from "../src/checkout";
import { chainRoutes, checkoutPage, html, mockFetch, nextDataPage, redirect, soldOutRoutes, WATCH } from "./helpers";

const CO = "checkout.playstation.com";

describe("buildBuyNowUrl", () => {
  it("matches the observed buy-now request shape", () => {
    const url = new URL(buildBuyNowUrl(WATCH, 1234));
    expect(url.host).toBe(CO);
    expect(url.pathname).toBe(`/buynow/${WATCH.sku}`);
    expect(url.searchParams.get("clientId")).toBe(WATCH.clientId);
    expect(url.searchParams.get("hostUrl")).toBe(`${WATCH.productUrl}?skuId=${WATCH.sku}&upSellService=NONE`);
    expect(url.searchParams.get("privacy-policy")).toBe("minimal");
    expect(url.searchParams.get("nonce")).toBe("1234");
    expect(url.searchParams.get("locale")).toBe("en-GB");
  });
});

describe("extractReason", () => {
  it("reads props.pageProps.reason from __NEXT_DATA__", () => {
    expect(extractReason(nextDataPage("skuOutOfStock", 0))).toBe("skuOutOfStock");
  });
  it("returns undefined when there is no reason", () => {
    expect(extractReason(nextDataPage(null, 0))).toBeUndefined();
    expect(extractReason("<html></html>")).toBeUndefined();
  });
});

describe("checkBuyNow", () => {
  it("full sold-out chain -> OUT_OF_STOCK", async () => {
    const f = mockFetch(soldOutRoutes());
    const r = await checkBuyNow(WATCH, f);
    expect(r.verdict).toBe("OUT_OF_STOCK");
    expect(r.reason).toBe("skuOutOfStock");
    expect(r.chain).toEqual([
      `302 ${CO}/buynow/${WATCH.sku}`,
      `302 ${CO}/unified/buynow/${WATCH.sku}`,
      `302 ${CO}/unified/buynow/${WATCH.sku}`,
      `200 ${CO}/error`,
    ]);
    // Every hop is fetched manually so the trail can be inspected.
    expect(f.calls.every((c) => c.init?.redirect === "manual")).toBe(true);
  });

  it("identifies itself honestly: own user agent, no referer", async () => {
    const f = mockFetch(soldOutRoutes());
    await checkBuyNow(WATCH, f);
    for (const c of f.calls) {
      const h = new Headers(c.init?.headers);
      expect(h.get("user-agent")).toBe("cf-webmonitor (personal stock check)");
      expect([...h.keys()].sort()).toEqual(["accept", "accept-language", "user-agent"]);
      expect(h.get("accept-language")).toBe("en-GB,en;q=0.9");
    }
  });

  it("chain ending on a normal checkout page -> AVAILABLE", async () => {
    const routes = soldOutRoutes();
    routes[`${CO}/unified/buynow/${WATCH.sku}`] = (url) =>
      url.searchParams.has("skuId") ? html(checkoutPage()) : redirect(`${url.pathname}?skuId=${WATCH.sku}`);
    const r = await checkBuyNow(WATCH, mockFetch(routes));
    expect(r.verdict).toBe("AVAILABLE");
    expect(r.chain.at(-1)).toBe(`200 ${CO}/unified/buynow/${WATCH.sku}`);
  });

  it("a genuine large page mentioning 'captcha' is still AVAILABLE (size guard)", async () => {
    const routes = soldOutRoutes();
    routes[`${CO}/unified/buynow/${WATCH.sku}`] = () => html(checkoutPage().replace("Review", "captcha Review"));
    const r = await checkBuyNow(WATCH, mockFetch(routes));
    expect(r.verdict).toBe("AVAILABLE");
  });

  it("a large /error page with challenge words but no reason is CHANGED, not BLOCKED", async () => {
    const f = mockFetch(chainRoutes(() => html(nextDataPage(null).replace("<body>", "<body>Access Denied"))));
    const r = await checkBuyNow(WATCH, f);
    expect(r.verdict).toBe("CHANGED");
  });

  it("off-site redirect -> CHANGED", async () => {
    const routes = soldOutRoutes();
    routes[`${CO}/unified/buynow/${WATCH.sku}`] = () => redirect("https://my.account.sony.com/sonyacct/signin/?x=1");
    const r = await checkBuyNow(WATCH, mockFetch(routes));
    expect(r.verdict).toBe("CHANGED");
    expect(r.detail).toContain("my.account.sony.com/sonyacct/signin/");
  });

  it("other error reason -> CHANGED with that reason", async () => {
    const r = await checkBuyNow(WATCH, mockFetch(chainRoutes(() => html(nextDataPage("skuNotFound")))));
    expect(r.verdict).toBe("CHANGED");
    expect(r.reason).toBe("skuNotFound");
  });

  it("404 on the chain -> CHANGED", async () => {
    const routes = soldOutRoutes();
    routes[`${CO}/buynow/${WATCH.sku}`] = () => html("not found", 404);
    const r = await checkBuyNow(WATCH, mockFetch(routes));
    expect(r.verdict).toBe("CHANGED");
  });

  it.each([403, 429, 503])("HTTP %i -> BLOCKED", async (status) => {
    const routes = soldOutRoutes();
    routes[`${CO}/buynow/${WATCH.sku}`] = () => html("nope", status);
    const r = await checkBuyNow(WATCH, mockFetch(routes));
    expect(r.verdict).toBe("BLOCKED");
  });

  it("small challenge page with 200 -> BLOCKED", async () => {
    const routes = soldOutRoutes();
    routes[`${CO}/buynow/${WATCH.sku}`] = () => html("<html><title>Pardon Our Interruption</title></html>");
    const r = await checkBuyNow(WATCH, mockFetch(routes));
    expect(r.verdict).toBe("BLOCKED");
  });

  it("small challenge page at /error -> BLOCKED", async () => {
    const r = await checkBuyNow(WATCH, mockFetch(chainRoutes(() => html("<p>Access Denied</p>"))));
    expect(r.verdict).toBe("BLOCKED");
  });

  it("network error / timeout -> FAILED", async () => {
    const routes = soldOutRoutes();
    routes[`${CO}/unified/buynow/${WATCH.sku}`] = () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const r = await checkBuyNow(WATCH, mockFetch(routes));
    expect(r.verdict).toBe("FAILED");
    expect(r.detail).toContain("timeout");
  });

  it("5xx -> FAILED", async () => {
    const r = await checkBuyNow(WATCH, mockFetch(chainRoutes(() => html("oops", 500))));
    expect(r.verdict).toBe("FAILED");
  });

  it("redirect loop -> FAILED", async () => {
    const f = mockFetch({ [`${CO}/buynow/${WATCH.sku}`]: (url) => redirect(url.pathname) });
    const r = await checkBuyNow(WATCH, f);
    expect(r.verdict).toBe("FAILED");
    expect(r.detail).toContain("redirects");
  });

  it("redirect without Location -> FAILED", async () => {
    const f = mockFetch({ [`${CO}/buynow/${WATCH.sku}`]: () => new Response(null, { status: 302 }) });
    expect((await checkBuyNow(WATCH, f)).verdict).toBe("FAILED");
  });
});
