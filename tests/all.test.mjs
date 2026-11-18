import test from "node:test";
import assert from "node:assert/strict";

import { keccak256Utf8 } from "../src/keccak256.mjs";
import { analyzeSpotToken, classifyMacroRegime, computeOrderbookMetrics, matchSpotPerpBasis, scoreNewsFeed } from "../src/analytics.mjs";
import {
  buildBatchNewOrderPayload,
  computeEip712DomainSeparator,
  computeExchangeActionDigest,
  formatSodexTypedSignature,
  validatePreTradeRisk,
} from "../src/riskAndEip712.mjs";
import { SodexClient } from "../src/sodexClient.mjs";
import { SosoValueClient } from "../src/sosoClient.mjs";

test("Keccak-256 matches canonical Ethereum empty string and transfer signature vectors", () => {
  assert.equal(
    keccak256Utf8(""),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
  );
  assert.equal(
    keccak256Utf8("Transfer(address,address,uint256)"),
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
  );
  assert.equal(
    keccak256Utf8("owner()"),
    "0x8da5cb5b36e7f68c1d2e56001220cdbdd3ba2616072f718acfda4a06441a807d"
  );
});

test("EIP-712 Domain Separator & SoDEX ExchangeAction digest build deterministically", () => {
  const sep = computeEip712DomainSeparator({
    name: "spot",
    version: "1",
    chainId: 286623,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  });
  assert.match(sep, /^0x[0-9a-f]{64}$/);

  const payload = buildBatchNewOrderPayload({
    accountID: 1010,
    symbolID: 24,
    clOrdID: "test_01",
    side: "BUY",
    orderType: "LIMIT",
    timeInForce: "GTC",
    price: "0.4000",
    quantity: "25.00",
  });
  assert.equal(payload.type, "batchNewOrder");
  assert.equal(payload.params.orders[0].side, 1);
  assert.equal(payload.params.orders[0].type, 1);

  const out = computeExchangeActionDigest({
    market: "spot",
    chainId: 286623,
    payload,
    nonce: 1760373925000,
  });
  assert.match(out.payloadHash, /^0x[0-9a-f]{64}$/);
  assert.match(out.digest, /^0x[0-9a-f]{64}$/);
  assert.equal(out.typedData.domain.chainId, 286623);
  assert.equal(formatSodexTypedSignature("0xabcd", false), "0x01abcd");
  assert.equal(formatSodexTypedSignature("0xabcd", true), "0x02abcd");
});

test("Pre-trade risk guard rejects unconfirmed, wide-spread, or misaligned tick orders", () => {
  const meta = { id: 24, tickSize: "0.0001", stepSize: "0.01", minNotional: "5", maxNotional: "0" };

  const blocked = validatePreTradeRisk({
    symbolMeta: meta,
    side: "BUY",
    orderType: "LIMIT",
    price: "0.39805", // misaligned with 0.0001 tick
    quantity: "100.00",
    spreadBps: 150, // exceeds 75 bps guard
    quoteVolume24h: 1000,
    riskConfig: { confirmed: false, maxSpreadBps: 75 },
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.checks.find((c) => c.name === "Orderbook Spread Guard").passed, false);
  assert.equal(blocked.checks.find((c) => c.name === "SoDEX Tick Size Alignment").passed, false);
  assert.equal(blocked.checks.find((c) => c.name === "Explicit Operator Confirmation").passed, false);

  const allowed = validatePreTradeRisk({
    symbolMeta: meta,
    side: "BUY",
    orderType: "LIMIT",
    price: "0.3980",
    quantity: "100.00",
    spreadBps: 2.5,
    quoteVolume24h: 500,
    riskConfig: { confirmed: true, maxSpreadBps: 75 },
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.notionalUsd, 39.8);
});

test("Orderbook metrics, basis matching, news sentiment, and macro regime classify coherently", async () => {
  const ob = {
    bids: [["100", "2"], ["99.9", "1"]],
    asks: [["100.1", "1"], ["100.2", "0.5"]],
  };
  const m = computeOrderbookMetrics(ob, 5);
  assert.equal(m.bestBid, 100);
  assert.equal(m.bestAsk, 100.1);
  assert.ok(m.imbalance > 0.3);

  const soso = new SosoValueClient("");
  const bundle = await soso.loadIntelligenceBundle();
  const scoredNews = scoreNewsFeed(bundle.hotNews);
  assert.ok(scoredNews.average > 0);

  const basis = matchSpotPerpBasis(
    [
      { id: 1, name: "vBTC_vUSDC", baseCoin: "vBTC", status: "TRADING" },
      { id: 2, name: "vADA_vUSDC", baseCoin: "vADA", status: "TRADING" },
    ],
    [
      { symbol: "vBTC_vUSDC", lastPx: "62000", bidPx: "61995", askPx: "62005", quoteVolume: "500000" },
      { symbol: "vADA_vUSDC", lastPx: "0.25", bidPx: "0", askPx: "0", quoteVolume: "100" },
    ],
    [
      { id: 10, name: "BTC-USD", baseCoin: "BTC", fundingInterval: 3600, status: "TRADING" },
      { id: 11, name: "ADA-USD", baseCoin: "ADA", fundingInterval: 3600, status: "TRADING" },
    ],
    [
      { symbol: "BTC-USD", lastPx: "62100", markPrice: "62100", indexPrice: "62000", askPx: "62102", bidPx: "62098", fundingRate: "0.000015", quoteVolume: "900000", openInterest: "100" },
      { symbol: "ADA-USD", lastPx: "0.15", markPrice: "0.15", indexPrice: "0.15", askPx: "0.1501", bidPx: "0.1499", fundingRate: "0.00001", quoteVolume: "10000", openInterest: "50" },
    ]
  );
  assert.equal(basis.length, 2);
  const btc = basis.find((r) => r.base === "BTC");
  const ada = basis.find((r) => r.base === "ADA");
  assert.ok(btc.spotSymbol === "vBTC_vUSDC" && btc.basisPct > 0);
  assert.ok(btc.fundingAprPct > 10);
  assert.equal(ada.spotSymbol, null); // zero-bid stale spot excluded
  assert.equal(ada.basisPct, 0);

  const regime = classifyMacroRegime({
    etfBtc: bundle.etfBtc,
    etfEth: bundle.etfEth,
    newsSentiment: scoredNews.average,
    basisRows: basis,
  });
  assert.equal(regime.regime, "RISK_ON");
});

test("Live SoDEX Mainnet API & ValueChain JSON-RPC integration smoke test", async () => {
  const sodex = new SodexClient("mainnet");
  const [spotSymbols, spotTickers, vcStatus] = await Promise.all([
    sodex.getSpotSymbols(),
    sodex.getSpotTickers(),
    sodex.getValueChainStatus(),
  ]);
  assert.ok(spotSymbols.length >= 20, "expected >=20 SoDEX mainnet spot symbols");
  const defiSsi = spotTickers.find((t) => t.symbol === "vDEFIssi_vUSDC");
  assert.ok(defiSsi, "expected live vDEFIssi_vUSDC ticker");

  const [ob, klines] = await Promise.all([
    sodex.getSpotOrderbook("vDEFIssi_vUSDC", 5),
    sodex.getSpotKlines("vDEFIssi_vUSDC", "1h", 10),
  ]);
  const analysis = analyzeSpotToken(defiSsi, spotSymbols.find((s) => s.name === "vDEFIssi_vUSDC"), ob, klines);
  assert.ok(analysis.lastPx > 0);
  assert.equal(vcStatus.chainId, 286623);
  assert.ok(vcStatus.blockNumber > 1000000);
});
