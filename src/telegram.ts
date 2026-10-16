import type { Env, Fetcher } from "./types";

const TIMEOUT_MS = 10_000;
/** Telegram rejects messages over 4096 characters. */
const MAX_LEN = 4000;

export interface SendResult {
  ok: boolean;
  /** true when Telegram is not configured and the message was only logged. */
  skipped?: boolean;
  error?: string;
}

export function telegramConfigured(env: Env): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

/**
 * Send a plain-text message. Never throws. Without the secrets it logs the
 * message and reports success, so the Worker still runs before setup is done.
 */
export async function sendTelegram(
  env: Env,
  text: string,
  opts: { silent?: boolean } = {},
  fetcher: Fetcher = fetch,
): Promise<SendResult> {
  if (!telegramConfigured(env)) {
    console.log(`[telegram not configured] ${text}`);
    return { ok: true, skipped: true };
  }
  const body = JSON.stringify({
    chat_id: env.TELEGRAM_CHAT_ID,
    text: text.length > MAX_LEN ? `${text.slice(0, MAX_LEN)}\n…(truncated)` : text,
    disable_web_page_preview: true,
    disable_notification: Boolean(opts.silent),
  });
  try {
    const res = await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    // Telegram's error body ("chat not found", "Unauthorized") never echoes the token.
    const detail = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status} ${detail.slice(0, 200)}`.trim() };
  } catch (e) {
    // The request URL contains the bot token; make sure it never reaches a log.
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, error: msg.split(env.TELEGRAM_BOT_TOKEN as string).join("<token>") };
  }
}
