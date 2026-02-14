import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import dotenv from "dotenv";
import YahooFinanceImport from "yahoo-finance2";
import fs from "fs";
import path from "path";

dotenv.config();
console.log("Node version:", process.version);

function createYahooClient(mod) {
  const YahooFinance = mod?.default ?? mod;
  if (YahooFinance && typeof YahooFinance === "object") return YahooFinance;

  if (typeof YahooFinance === "function") {
    const proto = YahooFinance.prototype || {};
    const hasProtoMethods =
      typeof proto.quote === "function" ||
      typeof proto.options === "function" ||
      typeof proto.chart === "function";

    if (hasProtoMethods) {
      try { return new YahooFinance({ suppressNotices: ["yahooSurvey"] }); } catch {}
      try { return new YahooFinance(); } catch {}
    }

    const hasDirectMethods =
      typeof YahooFinance.quote === "function" ||
      typeof YahooFinance.options === "function" ||
      typeof YahooFinance.chart === "function";

    if (hasDirectMethods) return YahooFinance;
    try { return new YahooFinance(); } catch {}
  }
  return null;
}

const yahooFinance = createYahooClient(YahooFinanceImport);

const cfg = {
  token: process.env.DISCORD_TOKEN,
  channelId: process.env.CHANNEL_ID,
  tickers: (process.env.TICKERS || "AAPL,TSLA").split(",").map(s => s.trim()).filter(Boolean),
  scanIntervalMinutes: Number(process.env.SCAN_INTERVAL_MINUTES || 15),
  maxAlertsPerScan: Number(process.env.MAX_ALERTS_PER_SCAN || 6),

  useEmbeds: (process.env.USE_EMBEDS ?? "true").toLowerCase() === "true",

  stopLossEnabled: (process.env.STOP_LOSS_ENABLED ?? "false").toLowerCase() === "true",
  stopLossPct: Number(process.env.STOP_LOSS_PCT || 25),

  includeCalls: (process.env.INCLUDE_CALLS ?? "true").toLowerCase() === "true",
  includePuts: (process.env.INCLUDE_PUTS ?? "true").toLowerCase() === "true",

  useTrendFilter: (process.env.USE_TREND_FILTER ?? "false").toLowerCase() === "true",

  dteMin: Number(process.env.DTE_MIN || 3),
  dteMax: Number(process.env.DTE_MAX || 21),

  strikeDistancePct: Number(process.env.STRIKE_DISTANCE_PCT || 0.08),

  minVolume: Number(process.env.MIN_VOLUME || 200),
  minOpenInterest: Number(process.env.MIN_OPEN_INTEREST || 200),
  maxIvPct: Number(process.env.MAX_IV_PCT || 60),

  minAbsDelta: Number(process.env.MIN_ABS_DELTA || 0.30),
  maxAbsDelta: Number(process.env.MAX_ABS_DELTA || 0.80),

  riskFreeRate: Number(process.env.RISK_FREE_RATE || 0.02),

  smallAccountMaxCost: Number(process.env.SMALL_ACCOUNT_MAX_COST || 150),
  smallAccountOnly: (process.env.SMALL_ACCOUNT_ONLY ?? "false").toLowerCase() === "true",

  vipOnly: (process.env.VIP_ONLY ?? "false").toLowerCase() === "true",
  vipChannelId: process.env.VIP_CHANNEL_ID || "",
  vipRoleId: process.env.VIP_ROLE_ID || "",
  tagVipRole: (process.env.TAG_VIP_ROLE ?? "false").toLowerCase() === "true",
};

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

if (!cfg.token || !cfg.channelId) {
  console.error("Missing DISCORD_TOKEN or CHANNEL_ID in .env");
  process.exit(1);
}

if (!yahooFinance || typeof yahooFinance.quote !== "function" || typeof yahooFinance.options !== "function") {
  console.error("Yahoo Finance client not loaded correctly (quote/options missing).");
  console.error("Fix: delete node_modules + package-lock.json, then run: npm install");
  process.exit(1);
}

const hasChart = yahooFinance && typeof yahooFinance.chart === "function";
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  prob = 1 - prob;
  return x < 0 ? 1 - prob : prob;
}
function normPdf(x) { return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x); }

function bsGreeks({ S, K, T, r, sigma, type }) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return { delta: 0, thetaPerDay: 0, popITM: 0.5 };
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const Nd1 = normCdf(d1);
  const Nd2 = normCdf(d2);

  let delta, theta;
  if (type === "call") {
    delta = Nd1;
    theta = -(S * normPdf(d1) * sigma) / (2 * sqrtT) - r * K * Math.exp(-r * T) * Nd2;
  } else {
    delta = Nd1 - 1;
    theta = -(S * normPdf(d1) * sigma) / (2 * sqrtT) + r * K * Math.exp(-r * T) * normCdf(-d2);
  }
  const thetaPerDay = theta / 365;
  const popITM = type === "call" ? Nd2 : normCdf(-d2);
  return { delta, thetaPerDay, popITM };
}

function parseExpiration(exp) {
  if (typeof exp === "number") return new Date((exp > 1e12 ? exp : exp * 1000));
  if (typeof exp === "string") return new Date(exp);
  if (exp instanceof Date) return exp;
  return new Date(String(exp));
}
function daysTo(expDate) { return Math.ceil((expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)); }

function pickMidPrice(c) {
  const bid = Number(c.bid), ask = Number(c.ask), last = Number(c.lastPrice);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) return (bid + ask) / 2;
  if (Number.isFinite(last) && last > 0) return last;
  if (Number.isFinite(ask) && ask > 0) return ask;
  if (Number.isFinite(bid) && bid > 0) return bid;
  return 0;
}

function scoreContract({ absDelta, ivPct, volume, openInterest, trendOk }) {
  let score = 0;
  if (absDelta >= cfg.minAbsDelta && absDelta <= cfg.maxAbsDelta) score += 3;
  if (ivPct > 0 && ivPct <= cfg.maxIvPct) score += 2;
  if (volume >= cfg.minVolume) score += 2;
  if (openInterest >= cfg.minOpenInterest) score += 2;
  if (trendOk) score += 1;
  return clamp(score, 0, 10);
}

const CACHE_FILE = path.join(process.cwd(), ".dedupe-cache.json");
let seen = new Map();
function loadCache() { try { seen = new Map(JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"))); } catch {} }
function saveCache() { try { fs.writeFileSync(CACHE_FILE, JSON.stringify([...seen.entries()]), "utf8"); } catch {} }
function pruneCache(hours=12) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  for (const [k, ts] of seen.entries()) if (ts < cutoff) seen.delete(k);
}

const trendCache = new Map();
async function getTrend(ticker) {
  if (!cfg.useTrendFilter || !hasChart) return "flat";

  const cached = trendCache.get(ticker);
  if (cached && (Date.now() - cached.ts) < 10 * 60 * 1000) return cached.direction;

  const nowSec = Math.floor(Date.now() / 1000);
  const period2 = nowSec;
  const period1 = nowSec - (90 * 24 * 60 * 60); // ~3 months

  try {
    const chart = await yahooFinance.chart(ticker, { period1, period2, interval: "1d" });
    const closes = (chart?.quotes || []).map(q => q.close).filter(n => Number.isFinite(n));
    if (closes.length < 55) { trendCache.set(ticker, { ts: Date.now(), direction: "flat" }); return "flat"; }

    const sma = (arr, n) => arr.slice(-n).reduce((a,b)=>a+b,0)/n;
    const sma20 = sma(closes, 20), sma50 = sma(closes, 50), last = closes[closes.length - 1];

    let direction = "flat";
    if (sma20 > sma50 && last >= sma20) direction = "bull";
    else if (sma20 < sma50 && last <= sma20) direction = "bear";

    trendCache.set(ticker, { ts: Date.now(), direction });
    return direction;
  } catch {
    trendCache.set(ticker, { ts: Date.now(), direction: "flat" });
    return "flat";
  }
}

function trendSupports(type, trendDir) {
  if (trendDir === "flat") return true;
  return type === "call" ? trendDir === "bull" : trendDir === "bear";
}

function buildAlertEmbed(r) {
  const kind = r.type === "call" ? "CALL" : "PUT";
  const expStr = r.expDate.toISOString().slice(0,10);
  const buyLine = r.buyIn > 0 ? `$${r.buyIn.toFixed(2)}` : "n/a";
  const sellLine = r.buyIn > 0 ? `$${r.sellTarget.toFixed(2)}` : "n/a";

  const deltaStr = Number.isFinite(r.delta) ? r.delta.toFixed(2) : "n/a";
  const thetaStr = Number.isFinite(r.thetaPerDay) ? r.thetaPerDay.toFixed(4) : "n/a";
  const ivStr = Number.isFinite(r.ivPct) ? `${r.ivPct.toFixed(1)}%` : "n/a";
  const popStr = Number.isFinite(r.pop) ? `${(r.pop*100).toFixed(1)}%` : "n/a";
  const costStr = r.approxCost > 0 ? `$${r.approxCost.toFixed(0)}` : "n/a";

  let stopLossText = "—";
  if (cfg.stopLossEnabled && Number.isFinite(cfg.stopLossPct) && cfg.stopLossPct > 0 && r.buyIn > 0) {
    const sl = r.buyIn * (1 - (cfg.stopLossPct / 100));
    stopLossText = `$${sl.toFixed(2)}  (-${cfg.stopLossPct}%)`;
  }

  const embed = new EmbedBuilder()
    .setTitle("🔥 SUPER ALERT")
    .setDescription(`**${r.ticker}** $${r.spot.toFixed(2)} • **${kind}** • Strike **$${r.strike}**\nExp: **${expStr}** (DTE: **${r.dte}**)`)
    .addFields(
      { name: "Trade", value: `Type: **BUY ${kind}**\nBuy-in: **${buyLine}**\nSell target: **${sellLine}** (~30%)\nStop-loss*: **${stopLossText}**`, inline: true },
      { name: "Score", value: `Rating: **${r.rating.toFixed(1)}/10**\nPOP*: **${popStr}**\nCost: **${costStr}** / contract`, inline: true },
      { name: "Greeks", value: `Delta: **${deltaStr}**\nTheta/day: **${thetaStr}**\nIV: **${ivStr}**`, inline: true },
    )
    .setFooter({ text: "Not financial advice. Stop-loss is a configurable helper value." });

  if (r.isSmallAccount) {
    embed.addFields({ name: "Mode", value: `Small-Account (≤ $${cfg.smallAccountMaxCost})`, inline: true });
  }

  return embed;
}

async function scanTicker(ticker) {
  const results = [];
  const trendDir = await getTrend(ticker);

  const quote = await yahooFinance.quote(ticker);
  const spot = Number(quote?.regularMarketPrice);
  if (!Number.isFinite(spot) || spot <= 0) return results;

  const options = await yahooFinance.options(ticker);
  const expiries = (options?.options || []).map(o => ({
    expDate: parseExpiration(o.expirationDate),
    calls: o.calls || [],
    puts: o.puts || [],
  }));

  for (const ex of expiries) {
    const dte = daysTo(ex.expDate);
    if (dte < cfg.dteMin || dte > cfg.dteMax) continue;

    const T = Math.max(dte, 1) / 365;

    const near = (c) => {
      const strike = Number(c.strike);
      if (!Number.isFinite(strike) || strike <= 0) return false;
      return (Math.abs(strike - spot) / spot) <= cfg.strikeDistancePct;
    };

    const candidates = [];
    if (cfg.includeCalls) for (const c of ex.calls) candidates.push({ ...c, _type: "call" });
    if (cfg.includePuts) for (const p of ex.puts) candidates.push({ ...p, _type: "put" });

    for (const c of candidates) {
      if (!near(c)) continue;

      const volume = Number(c.volume || 0);
      const openInterest = Number(c.openInterest || 0);
      if (volume < cfg.minVolume || openInterest < cfg.minOpenInterest) continue;

      const iv = Number(c.impliedVolatility);
      const sigma = Number.isFinite(iv) && iv > 0 ? iv : null;
      const ivPct = sigma ? sigma * 100 : NaN;
      if (Number.isFinite(ivPct) && ivPct > cfg.maxIvPct) continue;

      if (!trendSupports(c._type, trendDir)) continue;

      const K = Number(c.strike);
      const greeks = sigma
        ? bsGreeks({ S: spot, K, T, r: cfg.riskFreeRate, sigma, type: c._type })
        : { delta: NaN, thetaPerDay: NaN, popITM: NaN };

      const absDelta = Number.isFinite(greeks.delta) ? Math.abs(greeks.delta) : 0;
      if (absDelta < cfg.minAbsDelta || absDelta > cfg.maxAbsDelta) continue;

      const buyIn = pickMidPrice(c);
      if (!(buyIn > 0)) continue;

      const approxCost = buyIn * 100;
      const isSmallAccount = approxCost <= cfg.smallAccountMaxCost;
      if (cfg.smallAccountOnly && !isSmallAccount) continue;

      const rating = scoreContract({ absDelta, ivPct: ivPct || 999, volume, openInterest, trendOk: true });
      const sellTarget = buyIn * 1.3;

      results.push({
        ticker: ticker.toUpperCase(),
        spot, type: c._type, strike: K,
        expDate: ex.expDate, dte,
        buyIn, sellTarget, rating,
        delta: greeks.delta, thetaPerDay: greeks.thetaPerDay,
        ivPct, pop: greeks.popITM,
        approxCost, isSmallAccount,
      });
    }
  }

  results.sort((a,b) => (b.rating - a.rating) || (a.approxCost - b.approxCost));
  return results;
}

function makeKey(r) { return `${r.ticker}|${r.type}|${r.strike}|${r.expDate.toISOString().slice(0,10)}`; }

async function postAlerts(allResults) {
  const targetChannelId = (cfg.vipOnly && cfg.vipChannelId) ? cfg.vipChannelId : cfg.channelId;

  let channel;
  try {
    channel = await client.channels.fetch(targetChannelId);
  } catch (e) {
    console.error("Missing Access to CHANNEL_ID (or VIP_CHANNEL_ID).");
    console.error("Bot must be in the server and have View Channel + Send Messages + Embed Links.");
    throw e;
  }

  let posted = 0;
  for (const r of allResults) {
    if (posted >= cfg.maxAlertsPerScan) break;

    const key = makeKey(r);
    if (seen.has(key)) continue;

    const prefix = (cfg.tagVipRole && cfg.vipRoleId) ? `<@&${cfg.vipRoleId}>` : "";
    const embed = buildAlertEmbed(r);
    await channel.send({ content: prefix || undefined, embeds: [embed] });

    seen.set(key, Date.now());
    posted += 1;
    await sleep(900);
  }

  if (posted > 0) saveCache();
  return posted;
}

async function scanOnce() {
  pruneCache(12);

  const bucket = [];
  for (const t of cfg.tickers) {
    const ticker = t.trim().toUpperCase();
    if (!ticker) continue;

   try {
  bucket.push(...await scanTicker(ticker));
} catch (e) {
  console.log(`Scan error for ${ticker}:`, e);
  console.log("Cause:", e?.cause);
}
await sleep(650);

  bucket.sort((a,b) => (b.rating - a.rating) || (a.approxCost - b.approxCost));

  try {
    const posted = await postAlerts(bucket);
    console.log(`Scan done. Candidates: ${bucket.length}, Posted: ${posted}`);
  } catch (e) {
    console.log("Fatal scan error:", e?.message || e);
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  loadCache();

  await scanOnce();

  const ms = Math.max(1, cfg.scanIntervalMinutes) * 60 * 1000;
  setInterval(scanOnce, ms);
});

client.login(cfg.token);
