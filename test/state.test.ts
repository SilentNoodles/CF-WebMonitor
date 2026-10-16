import { describe, expect, it } from "vitest";
import type { BuyNowResult, Verdict } from "../src/checkout";
import {
  buyNowObservation,
  ctaObservation,
  decide,
  formatAlert,
  parseConfig,
  shouldPersist,
  type AlertEvent,
  type ChannelState,
  type Observation,
} from "../src/state";
import { WATCH } from "./helpers";

const CONFIG = { failureAlertAfter: 3, realertMinutes: 30 };
const MIN = 60_000;
const T0 = 1_700_000_000_000;

const DETAIL: Record<Verdict, string> = {
  OUT_OF_STOCK: "checkout reports skuOutOfStock",
  AVAILABLE: "landed on /unified/buynow/x (HTTP 200)",
  CHANGED: 'checkout error page with reason "skuNotFound"',
  BLOCKED: "HTTP 403",
  FAILED: "network error: timeout",
};

function buy(verdict: Verdict, detail = DETAIL[verdict]): Observation {
  const r: BuyNowResult = { verdict, detail, chain: ["302 a", "200 b"] };
  return buyNowObservation(r);
}
function cta(summary: string | null): Observation {
  return ctaObservation(
    summary === null ? { ok: false, detail: "GraphQL error: PersistedQueryNotFound" } : { ok: true, signature: summary, summary, detail: summary },
  );
}

/** Feed a sequence of (minute offset, observation) through decide, carrying state. */
function run(steps: [number, Observation][], start: ChannelState | null = null) {
  let state = start;
  const perStep: AlertEvent["kind"][][] = [];
  for (const [minute, obs] of steps) {
    const d = decide(state, obs, T0 + minute * MIN, CONFIG);
    perStep.push(d.events.map((e) => e.kind));
    state = d.next;
  }
  return { state: state!, perStep };
}

describe("decide: alert rules", () => {
  const cases: { name: string; steps: [number, Observation][]; expected: AlertEvent["kind"][][] }[] = [
    // First run
    { name: "first run quiet -> one-off started", steps: [[0, buy("OUT_OF_STOCK")]], expected: [["started"]] },
    { name: "first run AVAILABLE -> alert immediately", steps: [[0, buy("AVAILABLE")]], expected: [["available"]] },
    { name: "first run CHANGED -> alert immediately", steps: [[0, buy("CHANGED")]], expected: [["changed"]] },
    { name: "first run CTA -> started", steps: [[0, cta("PREORDER")]], expected: [["started"]] },
    {
      name: "steady sold-out stays quiet",
      steps: [[0, buy("OUT_OF_STOCK")], [5, buy("OUT_OF_STOCK")], [10, buy("OUT_OF_STOCK")]],
      expected: [["started"], [], []],
    },
    // Buy-now transitions
    {
      name: "sold out -> AVAILABLE alerts, re-alerts every 30 min while available",
      steps: [
        [0, buy("OUT_OF_STOCK")],
        [5, buy("AVAILABLE")],
        [10, buy("AVAILABLE")],
        [30, buy("AVAILABLE")],
        [35, buy("AVAILABLE")],
        [65, buy("AVAILABLE")],
        [70, buy("OUT_OF_STOCK")],
      ],
      expected: [["started"], ["available"], [], [], ["available"], ["available"], ["soldOutAgain"]],
    },
    {
      name: "CHANGED alerts once; same reason does not repeat; new reason alerts",
      steps: [
        [0, buy("OUT_OF_STOCK")],
        [5, buy("CHANGED")],
        [10, buy("CHANGED")],
        [60, buy("CHANGED")],
        [65, buy("CHANGED", "redirected off-site to my.account.sony.com/signin")],
      ],
      expected: [["started"], ["changed"], [], [], ["changed"]],
    },
    {
      name: "CHANGED -> AVAILABLE alerts",
      steps: [[0, buy("CHANGED")], [5, buy("AVAILABLE")]],
      expected: [["changed"], ["available"]],
    },
    // Failures
    {
      name: "failures: one alert after 3 in a row, then one recovered",
      steps: [
        [0, buy("OUT_OF_STOCK")],
        [5, buy("BLOCKED")],
        [10, buy("FAILED")],
        [15, buy("BLOCKED")],
        [20, buy("BLOCKED")],
        [25, buy("BLOCKED")],
        [30, buy("OUT_OF_STOCK")],
        [35, buy("OUT_OF_STOCK")],
      ],
      expected: [["started"], [], [], ["failing"], [], [], ["recovered"], []],
    },
    {
      name: "failures below the threshold reset quietly",
      steps: [[0, buy("OUT_OF_STOCK")], [5, buy("BLOCKED")], [10, buy("BLOCKED")], [15, buy("OUT_OF_STOCK")], [20, buy("BLOCKED")], [25, buy("BLOCKED")]],
      expected: [["started"], [], [], [], [], []],
    },
    {
      name: "failing from the very first run, then recovery sends recovered + started",
      steps: [[0, buy("BLOCKED")], [5, buy("BLOCKED")], [10, buy("BLOCKED")], [15, buy("OUT_OF_STOCK")]],
      expected: [[], [], ["failing"], ["recovered", "started"]],
    },
    {
      name: "recovering straight into AVAILABLE sends both",
      steps: [[0, buy("OUT_OF_STOCK")], [5, buy("FAILED")], [10, buy("FAILED")], [15, buy("FAILED")], [20, buy("AVAILABLE")]],
      expected: [["started"], [], [], ["failing"], ["recovered", "available"]],
    },
    {
      name: "failures while AVAILABLE do not reset the re-alert clock",
      steps: [[0, buy("AVAILABLE")], [5, buy("BLOCKED")], [10, buy("AVAILABLE")], [30, buy("AVAILABLE")]],
      expected: [["available"], [], [], ["available"]],
    },
    // CTA channel
    {
      name: "CTA: any signature change is informational; failures count the same way",
      steps: [
        [0, cta("PREORDER")],
        [5, cta("PREORDER")],
        [10, cta("OUT_OF_STOCK")],
        [15, cta(null)],
        [20, cta(null)],
        [25, cta(null)],
        [30, cta("OUT_OF_STOCK")],
        [35, cta("ADD_TO_CART")],
      ],
      expected: [["started"], [], ["ctaChanged"], [], [], ["failing"], ["recovered"], ["ctaChanged"]],
    },
  ];

  it.each(cases)("$name", ({ steps, expected }) => {
    expect(run(steps).perStep).toEqual(expected);
  });

  it("keeps the last good signature through failures", () => {
    const { state } = run([[0, buy("OUT_OF_STOCK")], [5, buy("BLOCKED")]]);
    expect(state.signature).toBe("OUT_OF_STOCK");
    expect(state.lastVerdict).toBe("BLOCKED");
    expect(state.failures).toBe(1);
  });

  it("respects FAILURE_ALERT_AFTER=1", () => {
    const d = decide(null, buy("BLOCKED"), T0, { ...CONFIG, failureAlertAfter: 1 });
    expect(d.events.map((e) => e.kind)).toEqual(["failing"]);
  });
});

describe("decide: Telegram send failure retry", () => {
  // The caller only persists `next` if every send succeeded. Simulate a failed
  // send by discarding `next` and deciding again from the old state.
  it("an AVAILABLE alert is re-produced on the next run if it was not delivered", () => {
    const { state } = run([[0, buy("OUT_OF_STOCK")]]);
    const first = decide(state, buy("AVAILABLE"), T0 + 5 * MIN, CONFIG);
    expect(first.events.map((e) => e.kind)).toEqual(["available"]);
    const retry = decide(state, buy("AVAILABLE"), T0 + 10 * MIN, CONFIG);
    expect(retry.events.map((e) => e.kind)).toEqual(["available"]);
  });

  it("a failing alert is re-produced on the next run if it was not delivered", () => {
    const { state } = run([[0, buy("OUT_OF_STOCK")], [5, buy("BLOCKED")], [10, buy("BLOCKED")]]);
    expect(decide(state, buy("BLOCKED"), T0 + 15 * MIN, CONFIG).events.map((e) => e.kind)).toEqual(["failing"]);
    expect(decide(state, buy("BLOCKED"), T0 + 20 * MIN, CONFIG).events.map((e) => e.kind)).toEqual(["failing"]);
  });

  it("the started message is retried until it is delivered", () => {
    expect(decide(null, buy("OUT_OF_STOCK"), T0, CONFIG).events.map((e) => e.kind)).toEqual(["started"]);
    expect(decide(null, buy("OUT_OF_STOCK"), T0 + MIN, CONFIG).events.map((e) => e.kind)).toEqual(["started"]);
  });
});

describe("shouldPersist", () => {
  it("writes on first run, on any real change, and hourly heartbeats only", () => {
    const a = decide(null, buy("OUT_OF_STOCK"), T0, CONFIG).next;
    expect(shouldPersist(null, a)).toBe(true);
    const same = decide(a, buy("OUT_OF_STOCK"), T0 + 5 * MIN, CONFIG).next;
    expect(shouldPersist(a, same)).toBe(false);
    const later = decide(a, buy("OUT_OF_STOCK"), T0 + 60 * MIN, CONFIG).next;
    expect(shouldPersist(a, later)).toBe(true);
    const failed = decide(a, buy("BLOCKED"), T0 + 5 * MIN, CONFIG).next;
    expect(shouldPersist(a, failed)).toBe(true);
  });
});

describe("parseConfig", () => {
  it("uses defaults for missing or silly values", () => {
    expect(parseConfig({})).toEqual({ failureAlertAfter: 3, realertMinutes: 30 });
    expect(parseConfig({ FAILURE_ALERT_AFTER: "0", REALERT_MINUTES: "1" })).toEqual({ failureAlertAfter: 3, realertMinutes: 30 });
    expect(parseConfig({ FAILURE_ALERT_AFTER: "5", REALERT_MINUTES: "60" })).toEqual({ failureAlertAfter: 5, realertMinutes: 60 });
  });
});

describe("formatAlert", () => {
  it("includes watch name, what changed, hop trail and product link", () => {
    const d = decide(null, buy("AVAILABLE"), T0, CONFIG);
    const a = formatAlert(WATCH, "buynow", d.events[0]!);
    expect(a.urgent).toBe(true);
    expect(a.text).toContain(WATCH.name);
    expect(a.text).toContain("AVAILABLE");
    expect(a.text).toContain("302 a\n200 b");
    expect(a.text).toContain(WATCH.productUrl);
  });

  it("CHANGED says check manually; failing is urgent; CTA is never urgent", () => {
    const changed = formatAlert(WATCH, "buynow", decide(null, buy("CHANGED"), T0, CONFIG).events[0]!);
    expect(changed.text).toMatch(/behaviour changed, check manually/i);
    const failing = formatAlert(WATCH, "buynow", { kind: "failing", failures: 3, detail: "BLOCKED (HTTP 403)", chain: [] });
    expect(failing.urgent).toBe(true);
    expect(failing.text).toContain("Monitor is failing");
    const ctaAlert = formatAlert(WATCH, "cta", { kind: "ctaChanged", from: "a", to: "b" });
    expect(ctaAlert.urgent).toBe(false);
  });
});
