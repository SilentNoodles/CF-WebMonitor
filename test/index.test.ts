import { describe, expect, it } from "vitest";
import { createWorker, runChecks, stateKey } from "../src/index";
import type { Env } from "../src/types";
import {
  CTA_HOST,
  ctaBody,
  html,
  jsonResponse,
  MemoryKV,
  mockFetch,
  soldOutRoutes,
  TELEGRAM_HOST,
  WATCH,
} from "./helpers";

const CO = "checkout.playstation.com";

function setup(
  opts: { telegram?: boolean; telegramOk?: () => boolean; available?: () => boolean; admin?: string; cta?: boolean } = {},
) {
  const kv = new MemoryKV();
  const sent: { text: string; silent: boolean }[] = [];
  const env: Env = {
    STATE: kv as unknown as KVNamespace,
    FAILURE_ALERT_AFTER: "3",
    REALERT_MINUTES: "30",
    CTA_CHECK: opts.cta === false ? "off" : "on",
    ...(opts.telegram === false ? {} : { TELEGRAM_BOT_TOKEN: "123:secret", TELEGRAM_CHAT_ID: "42" }),
    ...(opts.admin ? { ADMIN_TOKEN: opts.admin } : {}),
  };
  const routes = soldOutRoutes();
  const original = routes[`${CO}/unified/buynow/${WATCH.sku}`]!;
  routes[`${CO}/unified/buynow/${WATCH.sku}`] = (url, init) =>
    opts.available?.() && url.searchParams.has("skuId") ? html("<html>" + "x".repeat(40_000)) : original(url, init);
  routes[CTA_HOST] = () => jsonResponse(ctaBody());
  routes[TELEGRAM_HOST] = (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { text: string; disable_notification: boolean };
    if (opts.telegramOk && !opts.telegramOk()) return jsonResponse({ ok: false, description: "Too Many Requests" }, 429);
    sent.push({ text: body.text, silent: body.disable_notification });
    return jsonResponse({ ok: true });
  };
  const fetcher = mockFetch(routes);
  let clock = 1_700_000_000_000;
  const deps = { fetcher, watches: [WATCH], now: () => clock };
  return { kv, env, sent, fetcher, deps, advance: (min: number) => (clock += min * 60_000) };
}

describe("runChecks", () => {
  it("first run sends a started message per channel and stores a baseline", async () => {
    const t = setup();
    const reports = await runChecks(t.env, t.deps);
    expect(reports.map((r) => [r.channel, r.verdict, r.events])).toEqual([
      ["buynow", "OUT_OF_STOCK", ["started"]],
      ["cta", "OK", ["started"]],
    ]);
    expect(t.sent).toHaveLength(2);
    expect(t.sent.every((s) => s.silent)).toBe(true);
    expect(JSON.parse(t.kv.store.get(stateKey(WATCH, "buynow"))!).signature).toBe("OUT_OF_STOCK");
  });

  it("sends the Telegram request to sendMessage with the chat id", async () => {
    const t = setup();
    await runChecks(t.env, t.deps);
    const call = t.fetcher.calls.find((c) => c.url.includes(TELEGRAM_HOST))!;
    expect(call.url).toBe("https://api.telegram.org/bot123:secret/sendMessage");
    expect(call.init?.method).toBe("POST");
    expect(JSON.parse(String(call.init?.body)).chat_id).toBe("42");
  });

  it("restock sends a loud alert, and steady state does not write KV every run", async () => {
    let available = false;
    const t = setup({ available: () => available });
    await runChecks(t.env, t.deps);
    const putsAfterFirst = t.kv.puts;
    t.advance(5);
    await runChecks(t.env, t.deps);
    expect(t.kv.puts).toBe(putsAfterFirst); // nothing changed, no write
    available = true;
    t.advance(5);
    const reports = await runChecks(t.env, t.deps);
    expect(reports[0]!.events).toEqual(["available"]);
    const alert = t.sent.at(-1)!;
    expect(alert.silent).toBe(false);
    expect(alert.text).toContain("POSSIBLY IN STOCK");
    expect(alert.text).toContain(WATCH.productUrl);
  });

  it("a failed Telegram send leaves state untouched so the alert is retried", async () => {
    let telegramUp = true;
    let available = false;
    const t = setup({ telegramOk: () => telegramUp, available: () => available });
    await runChecks(t.env, t.deps);
    const before = t.kv.store.get(stateKey(WATCH, "buynow"));

    available = true;
    telegramUp = false;
    t.advance(5);
    const failed = await runChecks(t.env, t.deps);
    expect(failed[0]!.delivered).toBe(false);
    expect(failed[0]!.persisted).toBe(false);
    expect(t.kv.store.get(stateKey(WATCH, "buynow"))).toBe(before);

    telegramUp = true;
    t.advance(5);
    const retried = await runChecks(t.env, t.deps);
    expect(retried[0]!.events).toEqual(["available"]);
    expect(retried[0]!.persisted).toBe(true);
    expect(t.sent.filter((s) => s.text.includes("POSSIBLY IN STOCK"))).toHaveLength(1);
  });

  it("a blocked monitor alerts once after 3 runs, then recovers", async () => {
    let blocked = false;
    const t = setup();
    const routes = soldOutRoutes();
    const blockedFetch = mockFetch({
      ...routes,
      [`${CO}/buynow/${WATCH.sku}`]: (url, init) => (blocked ? html("denied", 403) : routes[`${CO}/buynow/${WATCH.sku}`]!(url, init)),
      [CTA_HOST]: () => jsonResponse(ctaBody()),
      [TELEGRAM_HOST]: (_u, init) => {
        t.sent.push({ text: JSON.parse(String(init?.body)).text, silent: false });
        return jsonResponse({ ok: true });
      },
    });
    const deps = { ...t.deps, fetcher: blockedFetch };
    await runChecks(t.env, deps);
    blocked = true;
    const kinds: string[][] = [];
    for (let i = 0; i < 4; i++) {
      t.advance(5);
      kinds.push((await runChecks(t.env, deps))[0]!.events);
    }
    blocked = false;
    t.advance(5);
    kinds.push((await runChecks(t.env, deps))[0]!.events);
    expect(kinds).toEqual([[], [], ["failing"], [], ["recovered"]]);
    expect(t.sent.some((s) => s.text.includes("Monitor is failing") && s.text.includes("HTTP 403"))).toBe(true);
  });

  it("with CTA_CHECK off (the default) only the buy-now check runs", async () => {
    for (const env of [{ CTA_CHECK: "off" }, { CTA_CHECK: undefined }]) {
      const t = setup();
      const reports = await runChecks({ ...t.env, ...env }, t.deps);
      expect(reports.map((r) => r.channel)).toEqual(["buynow"]);
      expect(t.fetcher.calls.some((c) => c.url.includes(CTA_HOST))).toBe(false);
      expect(t.kv.store.has(stateKey(WATCH, "cta"))).toBe(false);
    }
  });

  it("without Telegram secrets it logs and still persists", async () => {
    const t = setup({ telegram: false });
    const reports = await runChecks(t.env, t.deps);
    expect(reports.every((r) => r.persisted)).toBe(true);
    expect(t.fetcher.calls.some((c) => c.url.includes(TELEGRAM_HOST))).toBe(false);
  });
});

describe("fetch handler", () => {
  const req = (method: string, path: string, token?: string) =>
    new Request(`https://w.example${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });

  it("404s everything when ADMIN_TOKEN is unset", async () => {
    const t = setup();
    const w = createWorker(t.deps);
    expect((await w.fetch!(req("GET", "/status", "x") as never, t.env, {} as never)).status).toBe(404);
  });

  it("401s a wrong token", async () => {
    const t = setup({ admin: "right" });
    const w = createWorker(t.deps);
    expect((await w.fetch!(req("GET", "/status", "wrong") as never, t.env, {} as never)).status).toBe(401);
    expect((await w.fetch!(req("GET", "/status") as never, t.env, {} as never)).status).toBe(401);
  });

  it("POST /check runs the checks and GET /status shows state without secrets", async () => {
    const t = setup({ admin: "right" });
    const w = createWorker(t.deps);
    const check = await w.fetch!(req("POST", "/check", "right") as never, t.env, {} as never);
    expect(check.status).toBe(200);
    const body = (await check.json()) as { results: { verdict: string }[] };
    expect(body.results.map((r) => r.verdict)).toEqual(["OUT_OF_STOCK", "OK"]);

    const status = await w.fetch!(req("GET", "/status", "right") as never, t.env, {} as never);
    const text = await status.text();
    expect(JSON.parse(text).state[stateKey(WATCH, "buynow")].signature).toBe("OUT_OF_STOCK");
    expect(text).not.toContain("123:secret");
    expect(text).not.toContain("right");
  });

  it("POST /test-alert sends a message, or 503s when Telegram is not configured", async () => {
    const t = setup({ admin: "right" });
    const w = createWorker(t.deps);
    const ok = await w.fetch!(req("POST", "/test-alert", "right") as never, t.env, {} as never);
    expect(ok.status).toBe(200);
    expect(t.sent.at(-1)!.text).toContain("Test alert");

    const u = setup({ admin: "right", telegram: false });
    const res = await createWorker(u.deps).fetch!(req("POST", "/test-alert", "right") as never, u.env, {} as never);
    expect(res.status).toBe(503);
  });

  it("unknown routes and wrong methods 404", async () => {
    const t = setup({ admin: "right" });
    const w = createWorker(t.deps);
    expect((await w.fetch!(req("GET", "/check", "right") as never, t.env, {} as never)).status).toBe(404);
    expect((await w.fetch!(req("GET", "/", "right") as never, t.env, {} as never)).status).toBe(404);
  });

  it("scheduled() runs the checks", async () => {
    const t = setup();
    await createWorker(t.deps).scheduled!({} as never, t.env, {} as never);
    expect(t.kv.store.size).toBe(2);
  });
});
