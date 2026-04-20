/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import TelegramBot from "node-telegram-bot-api";

// Railway sets RAILWAY_ENVIRONMENT automatically; use it to detect cron/cloud mode
const IS_CRON = !!process.env.RAILWAY_ENVIRONMENT;

// ─── Telegram ─────────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let tgBot = null;

function initTelegram() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("⚠️  Telegram not configured — skipping notifications.");
    return;
  }
  tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: !IS_CRON });
  console.log("✅ Telegram bot connected");

  if (IS_CRON) return; // cron mode — send-only, no interactive command handlers

  // /start
  tgBot.onText(/\/start/, (msg) => {
    tgBot.sendMessage(
      msg.chat.id,
      `👋 *GVL Trading Bot online*\n\nCommands:\n/status — live marktdata\n/run — bot handmatig triggeren\n/summary — trade overzicht`,
      { parse_mode: "Markdown" },
    );
  });

  // /status — haal live data op en stuur terug
  tgBot.onText(/\/status/, async (msg) => {
    tgBot.sendMessage(msg.chat.id, "⏳ Marktdata ophalen...");
    try {
      const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
      const closes = candles.map((c) => c.close);
      const price = closes[closes.length - 1];
      const ema8 = calcEMA(closes, 8);
      const vwap = calcVWAP(candles);
      const rsi3 = calcRSI(closes, 3);

      const bullish = price > vwap && price > ema8;
      const bearish = price < vwap && price < ema8;
      const biasEmoji = bullish
        ? "🟢 BULLISH"
        : bearish
          ? "🔴 BEARISH"
          : "⚪️ NEUTRAL";

      tgBot.sendMessage(
        msg.chat.id,
        `📊 *${CONFIG.symbol} — ${CONFIG.timeframe}*\n\n` +
          `💰 Prijs:   $${price.toFixed(2)}\n` +
          `📈 EMA(8): $${ema8.toFixed(2)}\n` +
          `📊 VWAP:  $${vwap ? vwap.toFixed(2) : "N/A"}\n` +
          `⚡ RSI(3): ${rsi3 ? rsi3.toFixed(2) : "N/A"}\n\n` +
          `Bias: ${biasEmoji}`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      tgBot.sendMessage(msg.chat.id, `❌ Fout: ${err.message}`);
    }
  });

  // /run — bot handmatig triggeren
  tgBot.onText(/\/run/, async (msg) => {
    tgBot.sendMessage(msg.chat.id, "🤖 Bot handmatig gestart...");
    await run(false); // false = geen polling stop na run
  });

  // /summary — trade overzicht
  tgBot.onText(/\/summary/, (msg) => {
    if (!existsSync(CSV_FILE)) {
      tgBot.sendMessage(msg.chat.id, "Nog geen trades gelogd.");
      return;
    }
    const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
    const rows = lines.slice(1).map((l) => l.split(","));
    const live = rows.filter((r) => r[11] === "LIVE").length;
    const paper = rows.filter((r) => r[11] === "PAPER").length;
    const blocked = rows.filter((r) => r[11] === "BLOCKED").length;

    tgBot.sendMessage(
      msg.chat.id,
      `📋 *Trade overzicht*\n\n` +
        `✅ Live trades: ${live}\n` +
        `📋 Paper trades: ${paper}\n` +
        `🚫 Geblokkeerd: ${blocked}\n` +
        `📁 Totaal: ${rows.length}`,
      { parse_mode: "Markdown" },
    );
  });
}

async function sendTelegram(message) {
  if (!tgBot || !TELEGRAM_CHAT_ID) return;
  try {
    await tgBot.sendMessage(TELEGRAM_CHAT_ID, message, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.log(`⚠️  Telegram melding mislukt: ${err.message}`);
  }
}

// Stuur een trade signaal met inline knoppen — wacht op goedkeuring
async function sendTradeConfirmation(price, tradeSize, symbol) {
  if (!tgBot || !TELEGRAM_CHAT_ID) return true; // geen Telegram = auto-approve

  // Cron mode: can't wait for human input — auto-approve paper, reject live
  if (IS_CRON) {
    if (CONFIG.paperTrading) {
      await sendTelegram(
        `🤖 *Paper trade auto-approved*\n\n` +
          `${symbol} BUY @ $${price.toFixed(2)}\n` +
          `Bedrag: $${tradeSize.toFixed(2)}`,
      );
      return true;
    }
    await sendTelegram(
      `⚠️ Live trade auto-rejected in cron mode.\n` +
        `Set PAPER_TRADING=true or run locally to approve trades manually.`,
    );
    return false;
  }

  return new Promise((resolve) => {
    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Goedkeuren", callback_data: "approve" },
          { text: "❌ Afwijzen", callback_data: "reject" },
        ],
      ],
    };

    tgBot.sendMessage(
      TELEGRAM_CHAT_ID,
      `🚨 *TRADE SIGNAAL*\n\n` +
        `Symbol: ${symbol}\n` +
        `Prijs: $${price.toFixed(2)}\n` +
        `Bedrag: $${tradeSize.toFixed(2)}\n` +
        `Mode: ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"}\n\n` +
        `Wil je deze trade uitvoeren?`,
      { parse_mode: "Markdown", reply_markup: keyboard },
    );

    // Timeout na 60 seconden — geen reactie = afwijzen
    const timeout = setTimeout(() => {
      tgBot.sendMessage(TELEGRAM_CHAT_ID, "⏱ Timeout — trade afgewezen.");
      resolve(false);
    }, 60000);

    tgBot.once("callback_query", (query) => {
      clearTimeout(timeout);
      tgBot.answerCallbackQuery(query.id);
      if (query.data === "approve") {
        tgBot.sendMessage(TELEGRAM_CHAT_ID, "✅ Trade goedgekeurd!");
        resolve(true);
      } else {
        tgBot.sendMessage(TELEGRAM_CHAT_ID, "❌ Trade afgewezen.");
        resolve(false);
      }
    });
  });
}

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  if (IS_CRON) {
    // Railway provides env vars via the dashboard — no .env file present
    if (missing.length > 0) {
      console.log(`\n⚠️  Missing env vars: ${missing.join(", ")}`);
      console.log("Set these in the Railway dashboard under Variables.");
      process.exit(1);
    }
    return;
  }

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=1m",
        "",
        "# Telegram",
        "TELEGRAM_BOT_TOKEN=",
        "TELEGRAM_CHAT_ID=",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "1m",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");
    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );
    check(
      "RSI(3) below 30 (snap-back setup in uptrend)",
      "< 30",
      rsi3.toFixed(2),
      rsi3 < 30,
    );
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");
    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );
    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );
    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }
  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );
  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }
  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );
  return true;
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000")
    throw new Error(`BitGet order failed: ${data.msg}`);
  return data.data;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
  }
}

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "",
    quantity = "",
    totalUSD = "",
    fee = "",
    netAmount = "",
    orderId = "",
    mode = "",
    notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found.");
    return;
  }
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));
  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");
  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);
  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run(stopPollingAfter = true) {
  checkOnboarding();
  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    await sendTelegram("🚫 Bot gestopt — daglimiet bereikt.");
    return;
  }

  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules);
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    failed.forEach((f) => console.log(`   - ${f}`));

    // Stuur geblokkeerde run ook naar Telegram (elke 10e run om spam te voorkomen)
    const totalRuns = log.trades.length;
    if (totalRuns % 10 === 0) {
      await sendTelegram(
        `📊 *Bot update* — geen signaal\n\n` +
          `${CONFIG.symbol} @ $${price.toFixed(2)}\n` +
          `RSI(3): ${rsi3.toFixed(2)} | EMA(8): $${ema8.toFixed(2)}\n` +
          `Reden: ${failed[0]}`,
      );
    }
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    // Human in the loop — vraag goedkeuring via Telegram
    const approved = await sendTradeConfirmation(
      price,
      tradeSize,
      CONFIG.symbol,
    );

    if (!approved) {
      console.log("❌ Trade afgewezen via Telegram.");
      logEntry.orderPlaced = false;
    } else if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — would buy ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      await sendTelegram(
        `✅ *Paper trade uitgevoerd*\n\n` +
          `${CONFIG.symbol} BUY @ $${price.toFixed(2)}\n` +
          `Bedrag: $${tradeSize.toFixed(2)}`,
      );
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${CONFIG.symbol}`,
      );
      try {
        const order = await placeBitGetOrder(
          CONFIG.symbol,
          "buy",
          tradeSize,
          price,
        );
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
        await sendTelegram(
          `🔴 *Live trade uitgevoerd*\n\n` +
            `${CONFIG.symbol} BUY @ $${price.toFixed(2)}\n` +
            `Order ID: ${order.orderId}`,
        );
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
        await sendTelegram(`❌ Order mislukt: ${err.message}`);
      }
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  writeTradeCsv(logEntry);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Stop polling when bot has run once (local one-shot mode only)
  if (stopPollingAfter && tgBot && !IS_CRON) {
    tgBot.stopPolling();
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  initTelegram();

  // Als /run commando gebruikt wordt blijft de bot in polling mode
  // Anders: eenmalig draaien (cron/Railway mode)
  if (!process.argv.includes("--listen")) {
    run()
      .then(() => {
        if (IS_CRON) process.exit(0);
      })
      .catch((err) => {
        console.error("Bot error:", err);
        process.exit(1);
      });
  } else {
    console.log(
      "🤖 Bot luistert naar Telegram commando's... (Ctrl+C om te stoppen)",
    );
  }
}
