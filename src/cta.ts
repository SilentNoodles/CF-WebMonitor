import type { Fetcher, Watch } from "./types";
import { REQUEST_HEADERS } from "./checkout";

/**
 * Secondary signal: the product page's own button/price lookup.
 *
 * Observed behaviour: this still reports PREORDER while checkout says sold out,
 * so it is NOT a reliable stock signal. It is cheap, though, and may flip when
 * PlayStation updates the page, so we watch it and report any change.
 *
 * Off by default (CTA_CHECK in wrangler.toml): it is unverified whether the
 * lookup answers without the site's own origin/client headers, and we do not
 * send those.
 */

const ENDPOINT = "https://web.np.playstation.com/api/graphql/v1/op";
// Persisted-query hash taken from the site's front end. It can change when the
// site is redeployed; the Worker alerts if the lookup starts failing.
const OPERATION = "productRetrieveForCtasWithPrice";
const HASH = "911a43f47dbbf7b2f3d513d6237dedfd679e57af3f34787667a22ecad6a249cd";
const TIMEOUT_MS = 10_000;

export interface CtaResult {
  ok: boolean;
  /** Stable string; a change in it means the button/price/eligibility changed. */
  signature?: string;
  /** Human-readable one-liner. */
  summary?: string;
  detail: string;
}

export function buildCtaUrl(productId: string): string {
  const q = new URLSearchParams({
    operationName: OPERATION,
    variables: JSON.stringify({ productId }),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: HASH } }),
  });
  return `${ENDPOINT}?${q.toString()}`;
}

interface Cta {
  type?: string;
  action?: { type?: string };
  meta?: { ineligibilityReasons?: { type?: string; names?: string[] }[] };
  price?: { discountedPrice?: string; discountedValue?: number };
}

export async function checkCta(watch: Watch, fetcher: Fetcher = fetch): Promise<CtaResult> {
  let res: Response;
  try {
    res = await fetcher(buildCtaUrl(watch.productId), {
      // Same honest headers as the buy-now check: no origin or site client name.
      headers: { ...REQUEST_HEADERS, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, detail: `network error: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };

  let json: {
    errors?: { message?: string }[];
    data?: { productRetrieve?: { webctas?: Cta[] } | null };
  };
  try {
    json = await res.json();
  } catch {
    return { ok: false, detail: "response was not JSON" };
  }

  if (json.errors?.length) {
    const msg = json.errors[0]?.message ?? "unknown";
    const hint = /PersistedQueryNotFound/i.test(msg) ? " (site likely changed its query hash)" : "";
    return { ok: false, detail: `GraphQL error: ${msg}${hint}` };
  }

  const ctas = json.data?.productRetrieve?.webctas;
  if (!ctas) return { ok: false, detail: "no product/webctas in response" };

  const buttons = ctas.map((c) => `${c.type ?? "?"}/${c.action?.type ?? "?"}`);
  const prices = ctas.map((c) => c.price?.discountedValue ?? null);
  const ineligible = ctas.flatMap((c) =>
    (c.meta?.ineligibilityReasons ?? []).map((r) => `${r.type ?? "?"}:${(r.names ?? []).join("|")}`),
  );

  const signature = JSON.stringify({ buttons, prices, ineligible });
  const priceText = ctas.map((c) => c.price?.discountedPrice).find(Boolean) ?? "no price";
  const summary = `button ${buttons.join(", ") || "none"}, ${priceText}${ineligible.length ? `, flags ${ineligible.join(", ")}` : ""}`;
  return { ok: true, signature, summary, detail: summary };
}
