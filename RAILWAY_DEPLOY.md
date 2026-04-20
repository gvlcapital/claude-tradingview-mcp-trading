# Railway Deployment Guide

## How this bot runs on Railway

- **Data source**: Binance public API (no auth required) — no TradingView MCP in cloud mode
- **Schedule**: Every 15 minutes via Railway cron (`*/15 * * * *`)
- **Mode**: One-shot per cron tick — fetches candles, runs safety check, logs result, exits cleanly
- **Telegram**: Send-only in cron mode (no interactive polling). Notifications fire on signals and every 10th blocked run.
- **Trade confirmation**: Auto-approved for paper trades. Live trades are auto-rejected in cron mode — test locally first.

---

## Step 1 — Push your code to GitHub

Make sure your repo is on GitHub (Railway deploys from Git).

```bash
git add -A && git commit -m "ready for Railway" && git push
```

---

## Step 2 — Create a Railway project

1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project → Deploy from GitHub repo**
3. Select this repository
4. Railway will detect `railway.json` automatically

---

## Step 3 — Set environment variables

In your Railway project, go to **Variables** and add the following.  
Do **not** upload a `.env` file — paste each value individually.

### Required

| Variable | Description |
|---|---|
| `BITGET_API_KEY` | Your BitGet API key |
| `BITGET_SECRET_KEY` | Your BitGet secret key |
| `BITGET_PASSPHRASE` | Your BitGet API passphrase |

### Optional (but strongly recommended)

| Variable | Description | Default |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather | — |
| `TELEGRAM_CHAT_ID` | Your Telegram user/chat ID | — |

### Trading config

| Variable | Description | Default |
|---|---|---|
| `PAPER_TRADING` | `true` = log only, no real orders | `true` |
| `SYMBOL` | Trading pair | `BTCUSDT` |
| `TIMEFRAME` | Candle interval | `1m` |
| `PORTFOLIO_VALUE_USD` | Portfolio size for position sizing | `1000` |
| `MAX_TRADE_SIZE_USD` | Hard cap per trade | `100` |
| `MAX_TRADES_PER_DAY` | Daily trade limit | `3` |
| `TRADE_MODE` | `spot` or `futures` | `spot` |
| `BITGET_BASE_URL` | BitGet API endpoint | `https://api.bitget.com` |

> **Keep `PAPER_TRADING=true` until you have verified the strategy is working as expected.** To go live, change this to `false` in Railway Variables — no redeploy needed.

---

## Step 4 — Verify the cron schedule

Open `railway.json` — the schedule should be:

```json
"cronSchedule": "*/15 * * * *"
```

This fires every 15 minutes, matching the 1m candle strategy (enough data, not too frequent).

---

## Step 5 — Deploy and monitor

1. Railway auto-deploys on every push to your main branch
2. Go to **Deployments** to watch the first run's logs
3. You should see the bot print market data, run the safety check, and exit cleanly
4. If Telegram is configured, you'll receive a notification when a signal fires

---

## Cron mode behaviour

| Scenario | What happens |
|---|---|
| No signal (conditions not met) | Logs blocked run. Sends Telegram every 10th run. |
| Signal + paper trading | Auto-approves, logs PAPER trade, sends Telegram notification |
| Signal + live trading | Auto-rejects (live trades require local manual approval). Change `PAPER_TRADING=false` only after validating locally. |
| Missing env vars | Exits with error log listing which variables are missing |

---

## Caveats

- **Ephemeral filesystem**: `trades.csv` and `safety-check-log.json` are written to Railway's ephemeral disk and **reset on each deployment**. For persistent trade history, consider mounting a Railway volume or exporting logs to a database/webhook.
- **Daily trade counter**: Because `safety-check-log.json` resets on redeploy, the `MAX_TRADES_PER_DAY` counter also resets. Keep this in mind when doing frequent deploys.
- **Telegram commands** (`/status`, `/run`, `/summary`) only work when running locally with `node bot.js --listen`. They are disabled in cron mode.

---

## Running locally

```bash
# One-shot run (same as cron mode, minus the Railway env var)
node bot.js

# Interactive mode — listen for Telegram commands
node bot.js --listen

# Print tax summary from trades.csv
node bot.js --tax-summary
```
