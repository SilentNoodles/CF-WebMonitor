# cf-webmonitor

A small personal stock monitor. It runs on a Cloudflare Worker every 5 minutes and sends a Telegram message when the UK PlayStation **DualSense - Grand Theft Auto VI Black Limited Edition** controller stops looking sold out.

It has no runtime dependencies and fits in Cloudflare's free tier. It has no UI.

## How it works

Every 5 minutes the Worker runs two checks per product:

| Channel  | What it does | Trust |
|----------|--------------|-------|
| `buynow` | Replays the "Pre-Order" button's redirect chain on `checkout.playstation.com` and reads where it lands. While sold out, the chain ends on `/error` with `reason: "skuOutOfStock"`. | **The real stock signal** |
| `cta`    | Asks the product page's own button/price lookup (GraphQL). | Informational only. It reported `PREORDER` while the item was sold out. |

Buy-now verdicts are `OUT_OF_STOCK` (quiet), `AVAILABLE`, `CHANGED`, `BLOCKED` and `FAILED`.

### What you get alerted about

| Message | When |
|---|---|
| 🟢 **POSSIBLY IN STOCK** | Checkout lands on a normal page instead of the sold-out page. Repeats every 30 min while it stays that way. |
| 🟠 **Checkout behaviour changed, check manually** | Checkout gives a different error, redirects off-site (e.g. to sign-in), or returns a 4xx. Sent once per distinct change. |
| 🔴 **Monitor is failing** | 3 checks in a row were blocked (403/429/503 or challenge page) or failed (timeout, 5xx, redirect loop). Sent once, then ✅ **recovered** when a check works again. A broken monitor otherwise looks exactly like "still sold out". |
| ⚪ Sold out again | Back to the normal sold-out response after an alert (silent). |
| ℹ️ Product page button changed | The button/price lookup changed (silent; not a stock signal). |
| Monitoring started | The first successful check of each channel (silent; doubles as a setup check). |

Urgent messages (🟢 🟠 🔴) make a sound. The rest are sent silently.

State lives in Workers KV. The Worker only updates the stored state once every Telegram message for that change has been delivered, so if Telegram is down the next run sends the alert again instead of losing it.

## Setup

You need Node.js 20+ and a free Cloudflare account.

### 1. Install and log in

```sh
npm install
npx wrangler login
```

### 2. Create the KV namespace

```sh
npx wrangler kv namespace create STATE
```

Copy the printed `id` into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`. The id is not a secret.

### 3. Create the Telegram bot

1. In Telegram, open a chat with **@BotFather** (check for the blue verified tick).
2. Send `/newbot`.
3. Give it a display name, e.g. `My Stock Monitor`.
4. Give it a username ending in `bot`, e.g. `ben_stock_monitor_bot`. It must be unique.
5. BotFather replies with a **token** that looks like `123456789:AAH...`. Treat it as a password. Don't paste it into chats or commit it.
6. Open your new bot (BotFather links it) and press **Start** or send it any message, e.g. `hi`. The bot can't message you until you've messaged it first.
7. In your browser, open the following URL, with your token in place of `<token>`:
   `https://api.telegram.org/bot<token>/getUpdates`
8. Find `"chat":{"id":123456789,...` in the response. That number is your **chat id**.
   If you see `"result":[]`, send the bot another message and reload.

### 4. Deploy and add the secrets

```sh
npx wrangler deploy
```

This prints your Worker's URL, e.g. `https://cf-webmonitor.<your-subdomain>.workers.dev`.

Then set the three secrets. Each command prompts you to paste the value, so it never ends up in your shell history:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN   # the token from BotFather
npx wrangler secret put TELEGRAM_CHAT_ID     # the number from getUpdates
npx wrangler secret put ADMIN_TOKEN          # a long random string, see below
```

To make an admin token, run `openssl rand -hex 32` and paste the output. Keep a copy somewhere safe (e.g. your password manager); you need it to call the endpoints.

Secrets apply immediately. You don't need to redeploy.

> Do this straight after the deploy. Until the Telegram secrets are set, the cron only logs. It then records its baseline, and the "Monitoring started" message won't be sent later. `/test-alert` still works for checking setup.

### 5. Test it

```sh
WORKER=https://cf-webmonitor.<your-subdomain>.workers.dev
read -s ADMIN_TOKEN   # paste the admin token, press Enter

# Telegram setup check: you should get a message.
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $WORKER/test-alert

# Run the checks now (applies the normal alert rules).
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $WORKER/check

# Last stored state per channel.
curl -H "Authorization: Bearer $ADMIN_TOKEN" $WORKER/status
```

**Check the first `/check` result.** The `buynow` entry should say `"verdict": "OUT_OF_STOCK"`.

- If it says `BLOCKED`, PlayStation's bot protection is refusing requests from Cloudflare's network. Don't try to work around it. Instead, use a different signal or run the check from a different host.
- If it says `FAILED` or `CHANGED`, read the `chain` (hop trail) and `detail` fields.

Watch the live logs with `npx wrangler tail`.

## HTTP endpoints

All endpoints need `Authorization: Bearer <ADMIN_TOKEN>`. If `ADMIN_TOKEN` isn't set, every path returns 404.

| Route | What it does |
|---|---|
| `GET /status` | Last stored state for each channel. Doesn't include secrets. |
| `POST /check` | Runs every check now and returns the verdicts. Follows the normal alert rules, so it can send alerts. |
| `POST /test-alert` | Sends a test Telegram message. |

## Configuration

Non-secret settings live in `wrangler.toml` under `[vars]`:

| Var | Default | Meaning |
|---|---|---|
| `FAILURE_ALERT_AFTER` | `3` | Consecutive failed checks before "monitor is failing". |
| `REALERT_MINUTES` | `30` (min 5) | How often to repeat the in-stock alert while it stays available. |

The cron is `*/5 * * * *`. Please don't make it faster.

To watch another product, add an entry to `src/watches.ts`.

To start fresh (e.g. to get the "Monitoring started" messages again), delete the stored state:

```sh
npx wrangler kv key delete --remote --binding STATE "gta6-black-dualsense:buynow"
npx wrangler kv key delete --remote --binding STATE "gta6-black-dualsense:cta"
```

## Free-tier usage

- **Requests:** about 288 cron runs a day, each making 5 or 6 requests.
- **KV writes:** state is only written when something changes, plus one write an hour per channel. That's about 50 writes a day, against a free limit of 1,000.
- **KV reads:** about 600 a day.

## Development

```sh
npm run check        # typecheck + tests (vitest, fetch is mocked)
npm run dev          # local dev; trigger the cron at /__scheduled
npx wrangler deploy --dry-run --outdir dist   # validate the bundle
```

For local dev, copy `.dev.vars.example` to `.dev.vars`. `.dev.vars` and `*.har` are git-ignored. Never commit them.
