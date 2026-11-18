// Pure quantitative analytics: SSI Microstructure, Spot-Perp Funding Basis, Sentiment & Regime Classifier.

const POSITIVE_WORDS = [
  "inflow", "inflows", "surge", "accumulat", "expand", "expands", "positive",
  "stabilize", "rally", "breakout", "approval", "growth", "adoption", "institutional",
];
const NEGATIVE_WORDS = [
  "outflow", "outflows", "crash", "exploit", "hack", "uncertainty", "drop",
  "plunge", "halt", "ban", "liquidation", "lawsuit", "warning", "slump",
];

export function normalizeBaseCoin(coin) {
  if (!coin) return "";
  return coin.replace(/^v(?=[A-Z0-9])/, "").replace(/\.ssi$/i, "SSI").toUpperCase();
}

export function computeOrderbookMetrics(orderbook, levels = 5) {
  if (!orderbook || !Array.isArray(orderbook.bids) || !Array.isArray(orderbook.asks)) {
    return { bestBid: 0, bestAsk: 0, mid: 0, spreadBps: 0, bidDepthUsd: 0, askDepthUsd: 0, imbalance: 0 };
  }
  const bids = orderbook.bids.slice(0, levels).map(([p, q]) => [Number(p), Number(q)]);
  const asks = orderbook.asks.slice(0, levels).map(([p, q]) => [Number(p), Number(q)]);
  const bestBid = bids[0]?.[0] || 0;
  const bestAsk = asks[0]?.[0] || 0;
  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
  const spreadBps = mid > 0 && bestAsk >= bestBid && bestBid > 0 ? ((bestAsk - bestBid) / mid) * 10000 : 0;
  const bidDepthUsd = bids.reduce((s, [p, q]) => s + p * q, 0);
  const askDepthUsd = asks.reduce((s, [p, q]) => s + p * q, 0);
  const totalDepth = bidDepthUsd + askDepthUsd;
  const imbalance = totalDepth > 0 ? (bidDepthUsd - askDepthUsd) / totalDepth : 0;
  return {
    bestBid,
    bestAsk,
    mid,
    spreadBps: Number(spreadBps.toFixed(2)),
    bidDepthUsd: Number(bidDepthUsd.toFixed(2)),
    askDepthUsd: Number(askDepthUsd.toFixed(2)),
    imbalance: Number(imbalance.toFixed(4)),
  };
}

export function computeRealizedVolatilityPct(klines) {
  if (!Array.isArray(klines) || klines.length < 3) return 0;
  const ordered = [...klines].sort((a, b) => Number(a.t) - Number(b.t));
  const rets = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = Number(ordered[i - 1].c);
    const curr = Number(ordered[i].c);
    if (prev > 0 && curr > 0) rets.push(Math.log(curr / prev));
  }
  if (rets.length === 0) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  const hourlyVol = Math.sqrt(variance);
  return Number((hourlyVol * Math.sqrt(24) * 100).toFixed(2)); // daily equiv %
}

export function scoreNewsHeadline(title) {
  const text = (title || "").toLowerCase();
  let pos = 0;
  let neg = 0;
  for (const w of POSITIVE_WORDS) if (text.includes(w)) pos += 1;
  for (const w of NEGATIVE_WORDS) if (text.includes(w)) neg += 1;
  if (pos === 0 && neg === 0) return 0;
  return Number(((pos - neg) / (pos + neg)).toFixed(3));
}

export function scoreNewsFeed(newsList) {
  if (!Array.isArray(newsList) || newsList.length === 0) {
    return { average: 0, items: [] };
  }
  const items = newsList.map((n) => ({
    ...n,
    sentiment: scoreNewsHeadline(n.title),
  }));
  const average = Number((items.reduce((s, x) => s + x.sentiment, 0) / items.length).toFixed(3));
  return { average, items };
}

export function classifyMacroRegime({ etfBtc = [], etfEth = [], newsSentiment = 0, basisRows = [] }) {
  const btcRecent = etfBtc.slice(0, 3).reduce((s, r) => s + Number(r.total_net_inflow || 0), 0);
  const ethRecent = etfEth.slice(0, 3).reduce((s, r) => s + Number(r.total_net_inflow || 0), 0);
  const totalInflow3d = btcRecent + ethRecent;

  const avgFundingApr =
    basisRows.length > 0
      ? basisRows.slice(0, 10).reduce((s, r) => s + r.fundingAprPct, 0) / Math.min(basisRows.length, 10)
      : 0;

  let score = 0;
  if (totalInflow3d > 150_000_000) score += 45;
  else if (totalInflow3d > 0) score += 20;
  else if (totalInflow3d < -100_000_000) score -= 45;
  else score -= 15;

  score += Math.round(newsSentiment * 30);

  if (avgFundingApr > 35) score -= 15; // frothy leverage
  else if (avgFundingApr > 5) score += 15; // constructive carry
  else if (avgFundingApr < -10) score -= 15;

  score = Math.max(-100, Math.min(100, score));
  let regime = "NEUTRAL";
  let weights = { BTC: 0.4, ssiMAG7: 0.25, ssiDeFi: 0.15, USDC_Reserve: 0.2 };
  if (score >= 30) {
    regime = "RISK_ON";
    weights = { BTC: 0.35, ssiMAG7: 0.3, ssiDeFi: 0.25, USDC_Reserve: 0.1 };
  } else if (score <= -25) {
    regime = "RISK_OFF";
    weights = { BTC: 0.25, ssiMAG7: 0.15, ssiDeFi: 0.05, USDC_Reserve: 0.55 };
  }

  return {
    regime,
    score,
    btc3dInflowUsd: totalInflow3d - ethRecent,
    eth3dInflowUsd: ethRecent,
    avgFundingAprPct: Number(avgFundingApr.toFixed(2)),
    targetWeights: weights,
  };
}

export function matchSpotPerpBasis(spotSymbols, spotTickers, perpsSymbols, perpsTickers) {
  const spotSymMap = new Map(spotSymbols.map((s) => [s.name, s]));
  const spotByBase = new Map();
  for (const t of spotTickers) {
    const meta = spotSymMap.get(t.symbol);
    const base = normalizeBaseCoin(meta ? meta.baseCoin : t.symbol.split("_")[0]);
    const quoteVol = Number(t.quoteVolume || 0);
    if (!spotByBase.has(base) || quoteVol > Number(spotByBase.get(base).ticker.quoteVolume || 0)) {
      spotByBase.set(base, { symbolMeta: meta, ticker: t });
    }
  }

  const perpsSymMap = new Map(perpsSymbols.map((s) => [s.name, s]));
  const rows = [];

  for (const pt of perpsTickers) {
    const pMeta = perpsSymMap.get(pt.symbol);
    if (!pMeta || pMeta.status !== "TRADING") continue;
    const base = normalizeBaseCoin(pMeta.baseCoin);
    const spotMatch = spotByBase.get(base);

    const perpLast = Number(pt.lastPx || 0);
    const markPx = Number(pt.markPrice || perpLast);
    const indexPx = Number(pt.indexPrice || perpLast);
    const askPx = Number(pt.askPx || 0);
    const bidPx = Number(pt.bidPx || 0);
    const perpSpreadBps = markPx > 0 && askPx > bidPx && bidPx > 0 ? ((askPx - bidPx) / markPx) * 10000 : 0;

    const fundingIntervalSec = Number(pMeta.fundingInterval || 3600);
    const periodsPerYear = (365 * 86400) / fundingIntervalSec;
    const fundingRate = Number(pt.fundingRate || 0);
    const fundingAprPct = fundingRate * periodsPerYear * 100;

    let spotSymbol = null;
    let spotPx = null;
    let basisPct = null;
    let combinedQuoteVol = Number(pt.quoteVolume || 0);

    if (spotMatch) {
      const sBid = Number(spotMatch.ticker.bidPx || 0);
      const sAsk = Number(spotMatch.ticker.askPx || 0);
      const sTwoSided = sBid > 0 && sAsk > 0 && sAsk >= sBid;
      const sSpreadBps = sTwoSided ? ((sAsk - sBid) / ((sBid + sAsk) / 2)) * 10000 : Infinity;
      if (sTwoSided && sSpreadBps <= 300) {
        spotSymbol = spotMatch.ticker.symbol;
        spotPx = Number(((sBid + sAsk) / 2).toFixed(8));
        basisPct = ((markPx - spotPx) / spotPx) * 100;
        combinedQuoteVol += Number(spotMatch.ticker.quoteVolume || 0);
      }
    }
    if (basisPct === null && indexPx > 0) {
      basisPct = ((markPx - indexPx) / indexPx) * 100;
    }

    // Signal strength prioritizes cash-and-carry efficiency + liquidity + tight spread
    const absCarry = Math.abs(fundingAprPct);
    const basisEdge = Math.min(25, Math.abs(basisPct || 0) * 15);
    const spreadPenalty = Math.min(40, perpSpreadBps * 0.8);
    const liqBonus = combinedQuoteVol > 50000 ? 20 : combinedQuoteVol > 5000 ? 10 : 0;
    const direction = fundingRate >= 0 ? "LONG_SPOT_SHORT_PERP" : "LONG_PERP_CARRY";
    const signalScore = Math.max(-100, Math.min(100, Math.round(Math.min(55, absCarry * 0.9) + basisEdge + liqBonus - spreadPenalty)));

    rows.push({
      base,
      perpSymbol: pt.symbol,
      perpSymbolId: pMeta.id,
      spotSymbol,
      spotSymbolId: spotMatch?.symbolMeta?.id || null,
      spotPx,
      perpPx: perpLast,
      markPx,
      indexPx,
      basisPct: basisPct !== null ? Number(basisPct.toFixed(4)) : 0,
      fundingRatePct: Number((fundingRate * 100).toFixed(5)),
      fundingAprPct: Number(fundingAprPct.toFixed(2)),
      perpSpreadBps: Number(perpSpreadBps.toFixed(2)),
      quoteVolume24h: Number(combinedQuoteVol.toFixed(2)),
      openInterest: Number(pt.openInterest || 0),
      direction,
      signalScore,
      perpMeta: pMeta,
      spotMeta: spotMatch?.symbolMeta || null,
    });
  }

  return rows.sort((a, b) => b.signalScore - a.signalScore || b.quoteVolume24h - a.quoteVolume24h);
}

export function analyzeSpotToken(ticker, symbolMeta, orderbook, klines) {
  const ob = computeOrderbookMetrics(orderbook, 5);
  const lastPx = Number(ticker?.lastPx || ob.mid || 0);
  const vwap = Number(ticker?.vwap || lastPx || 0);
  const vwapDevPct = vwap > 0 ? ((lastPx - vwap) / vwap) * 100 : 0;
  const vol24hPct = computeRealizedVolatilityPct(klines);
  const changePct = Number(ticker?.changePct || 0);

  // Composite momentum + book-pressure score (-100 to +100)
  const rawScore = ob.imbalance * 45 + Math.max(-35, Math.min(35, vwapDevPct * 12)) + Math.max(-20, Math.min(20, changePct * 2));
  const signalScore = Math.max(-100, Math.min(100, Math.round(rawScore)));

  return {
    symbol: ticker.symbol,
    displayName: symbolMeta?.displayName || ticker.symbol,
    symbolId: symbolMeta?.id || null,
    lastPx,
    changePct: Number(changePct.toFixed(2)),
    quoteVolume24h: Number(Number(ticker.quoteVolume || 0).toFixed(2)),
    vwap: Number(vwap.toFixed(6)),
    vwapDevPct: Number(vwapDevPct.toFixed(3)),
    realizedVolPct: vol24hPct,
    orderbook: ob,
    signalScore,
    bias: signalScore >= 15 ? "ACCUMULATE" : signalScore <= -15 ? "TRIM / HEDGE" : "NEUTRAL",
    meta: symbolMeta || null,
    klines: klines || [],
    rawBook: orderbook || null,
  };
}
