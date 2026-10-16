# CF-WebMonitor

Lightweight, personal-use stock monitor that runs on a **Cloudflare Worker** (cron trigger, KV for state) and alerts via **Telegram**. First target: the UK PlayStation "DualSense - Grand Theft Auto VI Black Limited Edition" controller, which is currently sold out. Keep it small: no framework, no runtime dependencies, free-tier friendly, no UI.

## Status of this branch (`feat/initial-monitor`)

Drafted but **never compiled, tested or run**. The sandbox these files were written in could not reach the npm registry (`npm install` failed with ENOTFOUND), so `node_modules` was never installed and `tsc`/`vitest` were never run. Run `npm install && npm run typecheck` first and fix whatever it finds. Nothing has been exercised against the live site either:

- `package.json`, `tsconfig.json`, `wrangler.toml` (cron `*/5 * * * *`, KV binding `STATE`, vars), `.gitignore`, `.dev.vars.example`
- `src/types.ts` - `Env`, `Watch`, `Fetcher`
- `src/watches.ts` - the one watch (edit here to add products)
- `src/checkout.ts` - primary check: replays the buy-now redirect chain, returns a verdict
- `src/cta.ts` - secondary check: product-page button/price lookup

**Still to build:**

1. `src/state.ts` - pure `decide(prev, observation, now, config)` returning the next stored state plus events to send (see "Alert rules"). Unit test it thoroughly; this is where silent-failure bugs would live.
2. `src/telegram.ts` - `sendTelegram(env, text)` using `https://api.telegram.org/bot<token>/sendMessage`. If the secrets are unset, log instead of failing.
3. `src/index.ts` - `scheduled()` runs every watch (both checks, concurrently), feeds results through `decide`, sends events, persists state. Plus a small `fetch()` handler (see "HTTP endpoints").
4. Tests (`vitest`, mocked `fetch`) and fixtures for the checks (see "Testing").
5. `README.md` - setup and deploy, including **how to create the Telegram bot** (the user has not made one yet): message @BotFather, `/newbot`, copy the token; message the new bot once, then read the chat id from `https://api.telegram.org/bot<token>/getUpdates`.
6. Run `npm run check`, then `npx wrangler deploy --dry-run --outdir dist` to validate the bundle.

## What we learned from the browser captures (the evidence behind the design)

- **The product page cannot be used to detect stock.** `playstation.com/.../grand-theft-auto-vi-black-limited-edition/` is server-rendered and shows "Pre-Order" and 74.99 GBP even though the item is sold out.
- **The page's own button lookup is unreliable too.** `productRetrieveForCtasWithPrice` (GraphQL persisted query on `web.np.playstation.com`, plain GET, no cookies) returns `webctas[0].type = "PREORDER"`, `action.type = "BUY_NOW"` while checkout says sold out. It is kept only as a cheap secondary signal.
- **The real stock verdict comes from the buy-now flow**, which is plain server-side redirects (no JSON API, no JavaScript needed). Clicking Pre-Order did, three times with identical results:
  1. `GET https://checkout.playstation.com/buynow/<SKU>?clientId=...&hostUrl=<product page url + ?skuId=<SKU>&upSellService=NONE>&privacy-policy=minimal&nonce=<random 4 digits>&locale=en-GB` -> 302 to
  2. `/unified/buynow/<SKU>?clientId=...&hostUrl=...` -> 302 to
  3. `/unified/buynow/<SKU>?skuId=<SKU>&upSellService=NONE&clientId=...&hostUrl=...` -> 302 to
  4. `/error?skuId=<SKU>&upSellService=NONE&clientId=...` -> **200**, a ~300 KB Next.js page titled "Error | Checkout" whose `<script id="__NEXT_DATA__">` JSON has `props.pageProps.reason = "skuOutOfStock"`.
- The HAR showed no cookies on those requests. The requests were iframe navigations with a normal Chrome user agent and `referer: https://www.playstation.com/`. `clientId` is public (it appears in the product page HTML). `nonce` is just a random number.
- The SKU is `PSD001-PSDE02019_19-DUALSENSEGEYIO4E-E000YYCL3`; the product id (no `-E000YYCL3`) is `PSD001-PSDE02019_19-DUALSENSEGEYIO4E`.
- **Bot protection:** after the error page loads, `checkout.playstation.com` serves a bot-detection script (randomised paths, `sensor_data` POSTs). The redirect chain happened before it, so plain requests may work, but this is **unverified from a Worker**. Cloudflare egress IPs may be blocked or challenged.
- **Unknown:** what the chain does when the item is actually in stock. Assume it lands on a normal (non-`/error`) checkout page, possibly via a sign-in redirect off-site. The checks therefore treat "anything other than the known sold-out landing" as worth an alert.

## Design

### Verdicts (`src/checkout.ts`)

`OUT_OF_STOCK` (expected, quiet), `AVAILABLE` (landed on a non-error checkout page), `CHANGED` (different error reason, off-site redirect, 4xx), `BLOCKED` (403/429/503 or a small challenge page), `FAILED` (network error, timeout, 5xx, redirect loop). Challenge-text matching is only applied to small bodies (<30 KB) so the real ~300 KB pages can never be mistaken for a block, because a false "BLOCKED" on a genuine in-stock page would hide the restock.

### Alert rules (`src/state.ts`, to be written)

State is kept per watch per channel (`<watch id>:buynow`, `<watch id>:cta`) in KV. Persist the last stable signature, last verdict, consecutive failure count, whether a failure alert is outstanding, and the last alert time.

- **First run:** store a baseline. If the state is already non-quiet, alert immediately. If quiet, send a one-off "monitoring started, currently <state>" message (this doubles as a Telegram setup check).
- **Buy-now channel:** `AVAILABLE` and `CHANGED` alert immediately on transition (wording for `CHANGED` should say "behaviour changed, check manually"). While it stays `AVAILABLE`, re-alert every `REALERT_MINUTES` (default 30). A `CHANGED` with the same reason does not repeat.
- **CTA channel:** any change in the signature (button types, price, ineligibility flags) sends an informational alert. Never urgent.
- **Failures** (`BLOCKED` / `FAILED` / CTA not ok): count consecutive failures; after `FAILURE_ALERT_AFTER` (default 3) send **one** "monitor is failing: <detail>" alert, then one "recovered" alert when a check succeeds again. Rationale: a silently broken monitor looks identical to "still out of stock", so failure must be loud.
- **Persist state only if every Telegram send succeeded** (or Telegram is not configured). Otherwise the next run retries the transition and an alert is never lost.
- Alerts include the watch name, what changed, the hop trail, and the product page link.

### HTTP endpoints (`fetch()` handler)

All require `Authorization: Bearer <ADMIN_TOKEN>`. If `ADMIN_TOKEN` is unset, return 404 for everything.

- `GET /status` - last stored state for each channel (no secrets).
- `POST /check` - run all checks now and return the verdicts (does not bypass the alert rules).
- `POST /test-alert` - send a test Telegram message (setup aid).

### Config and secrets

Secrets via `wrangler secret put`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ADMIN_TOKEN`. Never commit them; `.dev.vars` and `*.har` are git-ignored. Non-secret settings live in `wrangler.toml` `[vars]`. The KV namespace id in `wrangler.toml` is a placeholder (`npx wrangler kv namespace create STATE`).

## Testing

- Use `vitest` with a mocked `fetch` (the `Fetcher` type exists for this). Cover: full sold-out chain -> `OUT_OF_STOCK`; chain ending on a normal page -> `AVAILABLE`; off-site redirect -> `CHANGED`; other error reason -> `CHANGED`; 403/429 and small challenge body -> `BLOCKED`; timeout/5xx/loop -> `FAILED`; CTA GraphQL error (incl. `PersistedQueryNotFound`) and missing data -> not ok.
- Build fixtures by hand from the structure above: a minimal HTML page containing `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"reason":"skuOutOfStock","query":{...}}}}</script>`, padded past 30 KB if the test needs to exercise the size guard. **Do not commit the browser HAR files** (they contain the user's signed-in session data).
- `decide()` needs table-driven tests covering every rule in "Alert rules", especially failure -> recovery and the Telegram-send-failure retry.

## First live test (do this early)

Before polishing, deploy (or `wrangler dev --remote`) and call `POST /check`. The first thing to learn is whether a Worker's request reaches `OUT_OF_STOCK`, or comes back `BLOCKED`. If it is blocked from Cloudflare's network, stop and tell the user rather than working around it with spoofing; the alternatives are a different signal or a different host for the check.

## Conventions

- TypeScript, strict. Keep dependencies to dev-only tooling.
- Polling no faster than every 5 minutes; be polite to the site.
- Commit messages end with the standard attribution trailers. Open changes as a branch/PR, not straight to `main`.
