import type { BuyNowResult } from "./checkout";
import type { CtaResult } from "./cta";
import type { Watch } from "./types";

/**
 * Alert decision logic. Pure: no I/O, no clock, so every rule can be tested.
 *
 * Each watch has two channels, stored separately in KV:
 *   buynow - the checkout redirect chain (the real stock signal)
 *   cta    - the product page's button lookup (informational only)
 */

export type Channel = "buynow" | "cta";

/** One check result, normalised so both channels go through the same rules. */
export interface Observation {
  channel: Channel;
  /** false when the check itself failed (BLOCKED / FAILED / CTA lookup not ok). */
  ok: boolean;
  /** Buy-now verdict, or "OK" / "ERROR" for the CTA channel. */
  verdict: string;
  /** Stable string for a successful check. A change in it is a transition. */
  signature?: string;
  /** Human-readable one-liner. */
  summary: string;
  /** Hop trail (buy-now only). */
  chain: string[];
}

export interface ChannelState {
  v: 1;
  /** Last successful signature; null until the first successful check. */
  signature: string | null;
  /** Summary that goes with `signature`. */
  summary: string;
  /** Verdict of the most recent check, including failures. */
  lastVerdict: string;
  lastDetail: string;
  lastChain: string[];
  /** Consecutive failed checks. */
  failures: number;
  /** A "monitor is failing" alert has been sent and not yet followed by "recovered". */
  failureAlerted: boolean;
  /** When the last stock alert (AVAILABLE) was sent, ms since epoch. */
  lastAlertAt: number | null;
  lastCheckedAt: number;
}

export interface DecideConfig {
  failureAlertAfter: number;
  realertMinutes: number;
}

export type AlertEvent =
  | { kind: "started"; summary: string }
  | { kind: "available"; summary: string; chain: string[]; repeat: boolean }
  | { kind: "changed"; summary: string; chain: string[] }
  | { kind: "soldOutAgain"; summary: string; chain: string[] }
  | { kind: "ctaChanged"; from: string; to: string }
  | { kind: "failing"; failures: number; detail: string; chain: string[] }
  | { kind: "recovered"; summary: string };

export interface Decision {
  next: ChannelState;
  events: AlertEvent[];
}

const QUIET_BUYNOW = "OUT_OF_STOCK";

export function decide(
  prev: ChannelState | null,
  obs: Observation,
  now: number,
  config: DecideConfig,
): Decision {
  const events: AlertEvent[] = [];
  const base: ChannelState = prev ?? {
    v: 1,
    signature: null,
    summary: "",
    lastVerdict: "",
    lastDetail: "",
    lastChain: [],
    failures: 0,
    failureAlerted: false,
    lastAlertAt: null,
    lastCheckedAt: 0,
  };
  const next: ChannelState = {
    ...base,
    lastVerdict: obs.verdict,
    lastDetail: obs.summary,
    lastChain: obs.chain,
    lastCheckedAt: now,
  };

  if (!obs.ok || obs.signature === undefined) {
    next.failures = base.failures + 1;
    if (next.failures >= config.failureAlertAfter && !base.failureAlerted) {
      events.push({ kind: "failing", failures: next.failures, detail: obs.summary, chain: obs.chain });
      next.failureAlerted = true;
    }
    return { next, events };
  }

  if (base.failureAlerted) events.push({ kind: "recovered", summary: obs.summary });
  next.failures = 0;
  next.failureAlerted = false;
  next.signature = obs.signature;
  next.summary = obs.summary;

  const isFirst = base.signature === null;
  const changed = base.signature !== obs.signature;

  if (obs.channel === "cta") {
    if (isFirst) events.push({ kind: "started", summary: obs.summary });
    else if (changed) events.push({ kind: "ctaChanged", from: base.summary, to: obs.summary });
    return { next, events };
  }

  // Buy-now channel.
  if (obs.verdict === "AVAILABLE") {
    const due = base.lastAlertAt === null || now - base.lastAlertAt >= config.realertMinutes * 60_000;
    if (changed || due) {
      events.push({ kind: "available", summary: obs.summary, chain: obs.chain, repeat: !changed });
      next.lastAlertAt = now;
    }
  } else if (obs.verdict === QUIET_BUYNOW) {
    if (isFirst) events.push({ kind: "started", summary: obs.summary });
    else if (changed) events.push({ kind: "soldOutAgain", summary: obs.summary, chain: obs.chain });
    next.lastAlertAt = null;
  } else {
    // CHANGED (or any verdict we do not know): alert once per distinct signature.
    if (changed) events.push({ kind: "changed", summary: obs.summary, chain: obs.chain });
    next.lastAlertAt = null;
  }
  return { next, events };
}

export function buyNowObservation(r: BuyNowResult): Observation {
  const ok = r.verdict !== "BLOCKED" && r.verdict !== "FAILED";
  return {
    channel: "buynow",
    ok,
    verdict: r.verdict,
    // CHANGED keys on its detail (reason / off-site target / status+path) so a
    // repeat of the same change stays quiet but a different one alerts again.
    signature: ok ? (r.verdict === "CHANGED" ? `CHANGED: ${r.detail}` : r.verdict) : undefined,
    summary: `${r.verdict} (${r.detail})`,
    chain: r.chain,
  };
}

export function ctaObservation(r: CtaResult): Observation {
  const ok = r.ok && r.signature !== undefined;
  return {
    channel: "cta",
    ok,
    verdict: ok ? "OK" : "ERROR",
    signature: ok ? r.signature : undefined,
    summary: r.summary ?? r.detail,
    chain: [],
  };
}

/**
 * Whether `next` is worth a KV write. KV's free tier allows 1,000 writes a day,
 * and a 5-minute cron with two channels would use 576 of them just to bump
 * `lastCheckedAt`, so skip writes that only refresh the timestamp unless it is
 * over `heartbeatMs` old.
 */
export function shouldPersist(prev: ChannelState | null, next: ChannelState, heartbeatMs = 60 * 60_000): boolean {
  if (!prev) return true;
  const strip = (s: ChannelState) => JSON.stringify({ ...s, lastCheckedAt: 0 });
  if (strip(prev) !== strip(next)) return true;
  return next.lastCheckedAt - prev.lastCheckedAt >= heartbeatMs;
}

export function parseConfig(env: { FAILURE_ALERT_AFTER?: string; REALERT_MINUTES?: string }): DecideConfig {
  return {
    failureAlertAfter: positiveInt(env.FAILURE_ALERT_AFTER, 3, 1),
    realertMinutes: positiveInt(env.REALERT_MINUTES, 30, 5),
  };
}

function positiveInt(raw: string | undefined, fallback: number, min: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

const CHANNEL_LABEL: Record<Channel, string> = {
  buynow: "checkout check",
  cta: "product page button",
};

export interface FormattedAlert {
  text: string;
  /** Non-urgent alerts are sent without a notification sound. */
  urgent: boolean;
}

export function formatAlert(watch: Watch, channel: Channel, e: AlertEvent): FormattedAlert {
  const label = CHANNEL_LABEL[channel];
  const hops = (chain: string[]) => (chain.length ? `\n\nHops:\n${chain.join("\n")}` : "");
  const link = `\n\n${watch.productUrl}`;
  switch (e.kind) {
    case "available":
      return {
        urgent: true,
        text:
          `🟢 ${e.repeat ? "STILL " : ""}POSSIBLY IN STOCK: ${watch.name}\n` +
          `Checkout no longer reports sold out: ${e.summary}` +
          link +
          hops(e.chain),
      };
    case "changed":
      return {
        urgent: true,
        text: `🟠 Checkout behaviour changed, check manually: ${watch.name}\n${e.summary}` + link + hops(e.chain),
      };
    case "soldOutAgain":
      return { urgent: false, text: `⚪ Sold out again: ${watch.name}\n${e.summary}` + link };
    case "ctaChanged":
      return {
        urgent: false,
        text:
          `ℹ️ Product page button changed (informational, not a stock signal): ${watch.name}\n` +
          `Was: ${e.from}\nNow: ${e.to}` +
          link,
      };
    case "failing":
      return {
        urgent: true,
        text:
          `🔴 Monitor is failing (${label}): ${watch.name}\n${e.detail}\n` +
          `${e.failures} failed checks in a row. Until this recovers a restock may NOT be detected.` +
          link +
          hops(e.chain),
      };
    case "recovered":
      return { urgent: false, text: `✅ Monitor recovered (${label}): ${watch.name}\nNow: ${e.summary}` };
    case "started":
      return {
        urgent: false,
        text: `Monitoring started (${label}): ${watch.name}\nCurrently: ${e.summary}` + link,
      };
  }
}
