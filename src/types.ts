export interface Env {
  /** KV namespace holding the last-seen state of each check. */
  STATE: KVNamespace;
  /** Secrets (set with `wrangler secret put`). All optional: without Telegram the Worker only logs. */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ADMIN_TOKEN?: string;
  /** Plain vars from wrangler.toml. */
  FAILURE_ALERT_AFTER?: string;
  REALERT_MINUTES?: string;
  /** "on" to run the secondary product-page button check. Anything else disables it. */
  CTA_CHECK?: string;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** One thing to watch. Add more entries to WATCHES to monitor more products. */
export interface Watch {
  id: string;
  name: string;
  /** Full SKU id, as used in the buy-now URL. */
  sku: string;
  /** Product id (SKU without the trailing edition suffix), used by the CTA lookup. */
  productId: string;
  /** Public product page, used as the host/referrer and as the link in alerts. */
  productUrl: string;
  /** Public web client id embedded in the product page HTML. */
  clientId: string;
}
