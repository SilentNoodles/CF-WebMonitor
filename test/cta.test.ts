import { describe, expect, it } from "vitest";
import { buildCtaUrl, checkCta } from "../src/cta";
import { CTA_HOST, ctaBody, html, jsonResponse, mockFetch, WATCH } from "./helpers";

const route = (r: () => Response) => mockFetch({ [CTA_HOST]: r });

describe("checkCta", () => {
  it("builds the persisted-query GET URL for the product id", () => {
    const url = new URL(buildCtaUrl(WATCH.productId));
    expect(url.searchParams.get("operationName")).toBe("productRetrieveForCtasWithPrice");
    expect(JSON.parse(url.searchParams.get("variables") ?? "{}")).toEqual({ productId: WATCH.productId });
  });

  it("summarises buttons and price with a stable signature", async () => {
    const a = await checkCta(WATCH, route(() => jsonResponse(ctaBody())));
    const b = await checkCta(WATCH, route(() => jsonResponse(ctaBody())));
    expect(a.ok).toBe(true);
    expect(a.summary).toBe("button PREORDER/BUY_NOW, £74.99");
    expect(a.signature).toBe(b.signature);
  });

  it("signature changes when the button changes", async () => {
    const a = await checkCta(WATCH, route(() => jsonResponse(ctaBody())));
    const b = await checkCta(WATCH, route(() => jsonResponse(ctaBody("OUT_OF_STOCK"))));
    expect(a.signature).not.toBe(b.signature);
  });

  it("identifies itself honestly: own user agent, no referer", async () => {
    const f = route(() => jsonResponse(ctaBody()));
    await checkCta(WATCH, f);
    const h = new Headers(f.calls[0]!.init?.headers);
    expect(h.get("user-agent")).toBe("cf-webmonitor (personal stock check)");
    expect(h.has("referer")).toBe(false);
  });

  it("PersistedQueryNotFound -> not ok, with a hint", async () => {
    const r = await checkCta(WATCH, route(() => jsonResponse({ errors: [{ message: "PersistedQueryNotFound" }] })));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("query hash");
  });

  it("other GraphQL error -> not ok", async () => {
    const r = await checkCta(WATCH, route(() => jsonResponse({ errors: [{ message: "boom" }] })));
    expect(r.ok).toBe(false);
  });

  it.each([
    ["null product", { data: { productRetrieve: null } }],
    ["no data", {}],
    ["no webctas", { data: { productRetrieve: {} } }],
  ])("missing data (%s) -> not ok", async (_label, body) => {
    const r = await checkCta(WATCH, route(() => jsonResponse(body)));
    expect(r.ok).toBe(false);
  });

  it("non-JSON -> not ok", async () => {
    expect((await checkCta(WATCH, route(() => html("<html>")))).ok).toBe(false);
  });

  it("HTTP error -> not ok", async () => {
    expect((await checkCta(WATCH, route(() => html("no", 403)))).ok).toBe(false);
  });

  it("network error -> not ok", async () => {
    const r = await checkCta(WATCH, route(() => { throw new TypeError("fetch failed"); }));
    expect(r.ok).toBe(false);
  });
});
