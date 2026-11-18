#!/usr/bin/env node
import { SSI_SPOT_SYMBOLS, SodexClient } from "../src/sodexClient.mjs";
import { SosoValueClient } from "../src/sosoClient.mjs";
import { analyzeSpotToken, classifyMacroRegime, matchSpotPerpBasis, scoreNewsFeed } from "../src/analytics.mjs";
import { buildBatchNewOrderPayload, computeExchangeActionDigest, validatePreTradeRisk } from "../src/riskAndEip712.mjs";

const network = process.argv.includes("--testnet") ? "testnet" : "mainnet";
const sosoKey = process.env.SOSO_API_KEY || "";

async function main() {
  const sodex = new SodexClient(network);
  const soso = new SosoValueClient(sosoKey);

  const [spotSymbols, spotTickers, perpsSymbols, perpsTickers, vcStatus, intel] = await Promise.all([
    sodex.getSpotSymbols(),
    sodex.getSpotTickers(),
    sodex.getPerpsSymbols(),
    sodex.getPerpsTickers(),
    sodex.getValueChainStatus(),
    soso.loadIntelligenceBundle(),
  ]);

  const availableSsi = SSI_SPOT_SYMBOLS.filter((sym) => spotTickers.some((t) => t.symbol === sym));
  const targets = availableSsi.length > 0 ? availableSsi : spotTickers.slice(0, 4).map((t) => t.symbol);

  const ssiAnalyses = await Promise.all(
    targets.map(async (sym) => {
      const ticker = spotTickers.find((t) => t.symbol === sym);
      const meta = spotSymbols.find((s) => s.name === sym);
      const [ob, kl] = await Promise.all([
        sodex.getSpotOrderbook(sym, 5),
        sodex.getSpotKlines(sym, "1h", 24),
      ]);
      return analyzeSpotToken(ticker, meta, ob, kl);
    })
  );

  const basisRows = matchSpotPerpBasis(spotSymbols, spotTickers, perpsSymbols, perpsTickers);
  const news = scoreNewsFeed(intel.hotNews);
  const regime = classifyMacroRegime({
    etfBtc: intel.etfBtc,
    etfEth: intel.etfEth,
    newsSentiment: news.average,
    basisRows,
  });

  console.log(`\n=== SoSoSignal Desk CLI Scan (${network.toUpperCase()}) ===`);
  console.log(`ValueChain ChainID: ${vcStatus.chainId} | Finalized/Latest Block: #${vcStatus.blockNumber}`);
  console.log(`SoSoValue Intel Mode: ${intel.source} | Macro Regime: ${regime.regime} (score=${regime.score})`);
  console.log(`Target Allocation Weights:`, JSON.stringify(regime.targetWeights));

  console.log(`\n--- Live SSI & Spot Index Microstructure ---`);
  for (const a of ssiAnalyses) {
    console.log(
      `  ${a.displayName.padEnd(16)} px=${String(a.lastPx).padEnd(10)} chg=${String(a.changePct + "%").padEnd(8)} spread=${a.orderbook.spreadBps}bps imb=${(a.orderbook.imbalance * 100).toFixed(1)}% sig=${a.signalScore} (${a.bias})`
    );
  }

  console.log(`\n--- Top 8 Spot-Perp Funding & Basis Screener ---`);
  for (const r of basisRows.slice(0, 8)) {
    console.log(
      `  ${r.base.padEnd(8)} ${r.perpSymbol.padEnd(14)} px=${String(r.perpPx).padEnd(10)} basis=${String(r.basisPct + "%").padEnd(9)} apr=${String(r.fundingAprPct + "%").padEnd(9)} spr=${r.perpSpreadBps}bps sig=${r.signalScore}`
    );
  }

  const topSpot = ssiAnalyses[0];
  if (topSpot && topSpot.meta) {
    const qtyNum = Math.max(Number(topSpot.meta.minQuantity || 1), Math.ceil(10 / (topSpot.orderbook.bestBid || topSpot.lastPx || 1)));
    const priceStr = (topSpot.orderbook.bestBid || topSpot.lastPx).toFixed(topSpot.meta.pricePrecision);
    const qtyStr = qtyNum.toFixed(topSpot.meta.quantityPrecision);
    const risk = validatePreTradeRisk({
      symbolMeta: topSpot.meta,
      side: "BUY",
      orderType: "LIMIT",
      price: priceStr,
      quantity: qtyStr,
      spreadBps: topSpot.orderbook.spreadBps,
      quoteVolume24h: topSpot.quoteVolume24h,
      riskConfig: { confirmed: true },
    });
    const payload = buildBatchNewOrderPayload({
      accountID: 1010,
      symbolID: topSpot.meta.id,
      clOrdID: `cli_preview_${Date.now()}`,
      side: "BUY",
      orderType: "LIMIT",
      timeInForce: "GTC",
      price: priceStr,
      quantity: qtyStr,
    });
    const digest = computeExchangeActionDigest({
      market: "spot",
      chainId: sodex.cfg.chainId,
      payload,
      nonce: Date.now(),
    });
    console.log(`\n--- Pre-Trade Risk Gate & EIP-712 Digest (${topSpot.symbol}) ---`);
    console.log(`  Allowed: ${risk.allowed} | Notional: $${risk.notionalUsd} | PayloadHash: ${digest.payloadHash}`);
    console.log(`  EIP-712 Digest: ${digest.digest}`);
  }
}

main().catch((err) => {
  console.error("Scan failed:", err);
  process.exit(1);
});
