import { checkBuyNow } from "./checkout";
import { checkCta } from "./cta";
import {
  buyNowObservation,
  ctaObservation,
  decide,
  formatAlert,
  parseConfig,
  shouldPersist,
  type AlertEvent,
  type Channel,
  type ChannelState,
  type Observation,
} from "./state";
import { sendTelegram, telegramConfigured } from "./telegram";
import type { Env, Fetcher, Watch } from "./types";
import { WATCHES } from "./watches";

const CHANNELS: Channel[] = ["buynow", "cta"];

export function stateKey(watch: Watch, channel: Channel): string {
  return `${watch.id}:${channel}`;
}

export interface ChannelReport {
  watch: string;
  channel: Channel;
  verdict: string;
  detail: string;
  chain: string[];
  events: AlertEvent["kind"][];
  /** false when a Telegram send failed; the state was left as-is so the next run retries. */
  delivered: boolean;
  persisted: boolean;
}

export interface RunDeps {
  fetcher?: Fetcher;
  now?: () => number;
  watches?: Watch[];
}

/** Run every check once, apply the alert rules, send alerts and save state. */
export async function runChecks(env: Env, deps: RunDeps = {}): Promise<ChannelReport[]> {
  const fetcher = deps.fetcher ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const config = parseConfig(env);
  const reports: ChannelReport[] = [];

  for (const watch of deps.watches ?? WATCHES) {
    const [buy, cta] = await Promise.all([
      checkBuyNow(watch, fetcher),
      ctaEnabled(env) ? checkCta(watch, fetcher) : Promise.resolve(null),
    ]);
    const observations: Observation[] = [buyNowObservation(buy)];
    if (cta) observations.push(ctaObservation(cta));

    for (const obs of observations) {
      const key = stateKey(watch, obs.channel);
      const prev = await readState(env, key);
      const { next, events } = decide(prev, obs, now(), config);

      let delivered = true;
      for (const event of events) {
        const alert = formatAlert(watch, obs.channel, event);
        const res = await sendTelegram(env, alert.text, { silent: !alert.urgent }, fetcher);
        if (!res.ok) {
          delivered = false;
          console.error(`Telegram send failed for ${key} (${event.kind}): ${res.error}`);
          break;
        }
      }

      // Only move the state forward once every alert for it is out, so a failed
      // send is retried on the next run instead of being lost.
      const persisted = delivered && shouldPersist(prev, next);
      if (persisted) await env.STATE.put(key, JSON.stringify(next));

      console.log(`${key}: ${obs.summary}${events.length ? ` -> ${events.map((e) => e.kind).join(", ")}` : ""}`);
      reports.push({
        watch: watch.id,
        channel: obs.channel,
        verdict: obs.verdict,
        detail: obs.summary,
        chain: obs.chain,
        events: events.map((e) => e.kind),
        delivered,
        persisted,
      });
    }
  }
  return reports;
}

/** The CTA check is opt-in: CTA_CHECK = "on" in wrangler.toml. */
export function ctaEnabled(env: Env): boolean {
  return env.CTA_CHECK?.trim().toLowerCase() === "on";
}

async function readState(env: Env, key: string): Promise<ChannelState | null> {
  const raw = await env.STATE.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ChannelState;
    return parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

async function handleFetch(request: Request, env: Env, deps: RunDeps): Promise<Response> {
  if (!env.ADMIN_TOKEN) return notFound();
  if (!authorised(request, env.ADMIN_TOKEN)) {
    return json({ error: "unauthorised" }, 401);
  }

  const { pathname } = new URL(request.url);
  const route = `${request.method} ${pathname}`;

  if (route === "GET /status") {
    const out: Record<string, ChannelState | null> = {};
    const channels = ctaEnabled(env) ? CHANNELS : CHANNELS.filter((c) => c !== "cta");
    for (const watch of deps.watches ?? WATCHES) {
      for (const channel of channels) {
        const key = stateKey(watch, channel);
        out[key] = await readState(env, key);
      }
    }
    return json({
      telegramConfigured: telegramConfigured(env),
      config: { ...parseConfig(env), ctaCheck: ctaEnabled(env) },
      state: out,
    });
  }

  if (route === "POST /check") {
    return json({ results: await runChecks(env, deps) });
  }

  if (route === "POST /test-alert") {
    if (!telegramConfigured(env)) {
      return json({ ok: false, error: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not both set" }, 503);
    }
    const res = await sendTelegram(env, "✅ Test alert from cf-webmonitor. Telegram is set up.", {}, deps.fetcher);
    return json(res, res.ok ? 200 : 502);
  }

  return notFound();
}

/** Constant-time comparison of the bearer token. */
function authorised(request: Request, token: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  const a = new TextEncoder().encode(header);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

/** Factory so tests can inject a fetch mock, clock and watch list. */
export function createWorker(deps: RunDeps = {}): ExportedHandler<Env> {
  return {
    async scheduled(_controller, env) {
      await runChecks(env, deps);
    },
    async fetch(request, env) {
      return handleFetch(request, env, deps);
    },
  };
}

export default createWorker();
