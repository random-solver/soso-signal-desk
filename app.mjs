import { SSI_SPOT_SYMBOLS, SodexClient } from "./src/sodexClient.mjs";
import { SosoValueClient } from "./src/sosoClient.mjs";
import { analyzeSpotToken, classifyMacroRegime, matchSpotPerpBasis, scoreNewsFeed } from "./src/analytics.mjs";
import {
  buildBatchNewOrderPayload,
  computeExchangeActionDigest,
  formatSodexTypedSignature,
  validatePreTradeRisk,
} from "./src/riskAndEip712.mjs";

const STORAGE_KEY_API = "sososignal_soso_api_key";
const STORAGE_KEY_LEDGER = "sososignal_paper_ledger";

const sodex = new SodexClient("mainnet");
const soso = new SosoValueClient(localStorage.getItem(STORAGE_KEY_API) || "");

const state = {
  selectedSymbol: "vDEFIssi_vUSDC",
  spotSymbols: [],
  spotTickers: [],
  perpsSymbols: [],
  perpsTickers: [],
  ssiAnalyses: [],
  basisRows: [],
  selectedAnalysis: null,
  lastDigest: null,
  filterText: "",
};

const els = {
  networkSelect: document.getElementById("networkSelect"),
  sosoApiKeyInput: document.getElementById("sosoApiKeyInput"),
  saveKeyBtn: document.getElementById("saveKeyBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  sodexStatus: document.getElementById("sodexStatus"),
  vcBlock: document.getElementById("vcBlock"),
  vcChainId: document.getElementById("vcChainId"),
  sosoSource: document.getElementById("sosoSource"),
  regimeBadge: document.getElementById("regimeBadge"),
  sosoModeBadge: document.getElementById("sosoModeBadge"),
  ssiCards: document.getElementById("ssiCards"),
  selectedChartTitle: document.getElementById("selectedChartTitle"),
  selectedStatsBadge: document.getElementById("selectedStatsBadge"),
  klineSvg: document.getElementById("klineSvg"),
  chartMetrics: document.getElementById("chartMetrics"),
  bookHeightBadge: document.getElementById("bookHeightBadge"),
  orderbookView: document.getElementById("orderbookView"),
  regimePanel: document.getElementById("regimePanel"),
  newsFeed: document.getElementById("newsFeed"),
  macroList: document.getElementById("macroList"),
  screenerFilter: document.getElementById("screenerFilter"),
  basisTableBody: document.getElementById("basisTableBody"),
  orderForm: document.getElementById("orderForm"),
  orderSymbolSelect: document.getElementById("orderSymbolSelect"),
  orderAccountId: document.getElementById("orderAccountId"),
  orderSide: document.getElementById("orderSide"),
  orderTif: document.getElementById("orderTif"),
  orderPrice: document.getElementById("orderPrice"),
  orderQuantity: document.getElementById("orderQuantity"),
  riskMaxNotional: document.getElementById("riskMaxNotional"),
  riskMaxSpread: document.getElementById("riskMaxSpread"),
  riskConfirmCheck: document.getElementById("riskConfirmCheck"),
  signWalletBtn: document.getElementById("signWalletBtn"),
  riskChecksOut: document.getElementById("riskChecksOut"),
  eip712Preview: document.getElementById("eip712Preview"),
  paperLedger: document.getElementById("paperLedger"),
};

if (localStorage.getItem(STORAGE_KEY_API)) {
  els.sosoApiKeyInput.value = localStorage.getItem(STORAGE_KEY_API);
}

function fmtUsd(val, decimals = 2) {
  const n = Number(val);
  if (!Number.isFinite(n)) return "--";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(decimals)}`;
}

function fmtPrice(px) {
  const n = Number(px);
  if (!Number.isFinite(n)) return "--";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function renderSsiCards() {
  els.ssiCards.innerHTML = "";
  for (const item of state.ssiAnalyses) {
    const div = document.createElement("div");
    div.className = `ssi-card ${item.symbol === state.selectedSymbol ? "active" : ""}`;
    const cls = item.changePct >= 0 ? "pos" : "neg";
    div.innerHTML = `
      <div class="ssi-title">
        <span>${item.displayName}</span>
        <span class="sig-pill ${item.signalScore >= 0 ? "pos" : "neg"}">Sig ${item.signalScore >= 0 ? "+" : ""}${item.signalScore}</span>
      </div>
      <div class="ssi-price">${fmtPrice(item.lastPx)}</div>
      <div class="ssi-meta">
        <span class="${cls}">${item.changePct >= 0 ? "+" : ""}${item.changePct}%</span>
        <span>Spread ${item.orderbook.spreadBps} bps</span>
      </div>
      <div class="ssi-meta">
        <span>${item.bias}</span>
        <span>Vol24h ${fmtUsd(item.quoteVolume24h, 0)}</span>
      </div>
    `;
    div.addEventListener("click", () => selectSymbol(item.symbol));
    els.ssiCards.appendChild(div);
  }
}

function renderKlineChart(analysis) {
  const klines = [...(analysis?.klines || [])].sort((a, b) => Number(a.t) - Number(b.t));
  const svg = els.klineSvg;
  if (klines.length < 2) {
    svg.innerHTML = `<text x="20" y="95" fill="#8ea0be" font-size="13">No kline candles available for this symbol on ${sodex.networkName}</text>`;
    return;
  }
  const w = 640;
  const h = 190;
  const pad = 20;
  const lows = klines.map((k) => Number(k.l));
  const highs = klines.map((k) => Number(k.h));
  const minPx = Math.min(...lows);
  const maxPx = Math.max(...highs);
  const span = maxPx - minPx || maxPx * 0.01 || 1;
  const xStep = (w - pad * 2) / Math.max(1, klines.length - 1);
  const yOf = (p) => h - pad - ((p - minPx) / span) * (h - pad * 2);

  const pts = klines.map((k, idx) => `${(pad + idx * xStep).toFixed(1)},${yOf(Number(k.c)).toFixed(1)}`).join(" ");
  const vwapY = yOf(analysis.vwap);
  const lastY = yOf(Number(klines[klines.length - 1].c));

  const candlesSvg = klines
    .map((k, idx) => {
      const x = pad + idx * xStep;
      const o = yOf(Number(k.o));
      const c = yOf(Number(k.c));
      const hi = yOf(Number(k.h));
      const lo = yOf(Number(k.l));
      const color = Number(k.c) >= Number(k.o) ? "#10b981" : "#ef4444";
      const top = Math.min(o, c);
      const bodyH = Math.max(2, Math.abs(o - c));
      return `<line x1="${x.toFixed(1)}" y1="${hi.toFixed(1)}" x2="${x.toFixed(1)}" y2="${lo.toFixed(1)}" stroke="${color}" stroke-width="1.2"/>
              <rect x="${(x - 3).toFixed(1)}" y="${top.toFixed(1)}" width="6" height="${bodyH.toFixed(1)}" fill="${color}" rx="1"/>`;
    })
    .join("");

  svg.innerHTML = `
    <line x1="${pad}" y1="${vwapY.toFixed(1)}" x2="${w - pad}" y2="${vwapY.toFixed(1)}" stroke="#f59e0b" stroke-dasharray="4 4" stroke-width="1"/>
    <text x="${pad + 4}" y="${Math.max(14, vwapY - 4).toFixed(1)}" fill="#f59e0b" font-size="10">24h VWAP ${fmtPrice(analysis.vwap)}</text>
    <polyline fill="none" stroke="rgba(59,130,246,0.45)" stroke-width="1.5" points="${pts}" />
    ${candlesSvg}
    <circle cx="${(pad + (klines.length - 1) * xStep).toFixed(1)}" cy="${lastY.toFixed(1)}" r="3.5" fill="#60a5fa"/>
  `;

  els.selectedChartTitle.textContent = `${analysis.displayName} (${analysis.symbol}) — Hourly Candles & VWAP`;
  els.selectedStatsBadge.textContent = `Signal ${analysis.signalScore >= 0 ? "+" : ""}${analysis.signalScore} (${analysis.bias})`;
  els.chartMetrics.innerHTML = `
    <span>Last: <strong>${fmtPrice(analysis.lastPx)}</strong></span>
    <span>VWAP Dev: <strong class="${analysis.vwapDevPct >= 0 ? "pos" : "neg"}">${analysis.vwapDevPct}%</strong></span>
    <span>Book Imbalance: <strong class="${analysis.orderbook.imbalance >= 0 ? "pos" : "neg"}">${(analysis.orderbook.imbalance * 100).toFixed(1)}%</strong></span>
    <span>Daily Eq. Vol: <strong>${analysis.realizedVolPct}%</strong></span>
  `;
}

function renderOrderbook(analysis) {
  const ob = analysis?.rawBook;
  if (!ob) {
    els.orderbookView.innerHTML = `<div class="panel-desc">No orderbook depth loaded.</div>`;
    return;
  }
  els.bookHeightBadge.textContent = `block ${ob.blockHeight || "--"}`;
  const bids = (ob.bids || []).slice(0, 6);
  const asks = (ob.asks || []).slice(0, 6);
  els.orderbookView.innerHTML = `
    <div>
      <div class="ob-col-title">Bids (Depth $${analysis.orderbook.bidDepthUsd.toLocaleString()})</div>
      ${bids.map(([p, q]) => `<div class="ob-row ob-bid"><span>${p}</span><span>${q}</span></div>`).join("")}
    </div>
    <div>
      <div class="ob-col-title">Asks (Depth $${analysis.orderbook.askDepthUsd.toLocaleString()})</div>
      ${asks.map(([p, q]) => `<div class="ob-row ob-ask"><span>${p}</span><span>${q}</span></div>`).join("")}
    </div>
  `;
}

function renderRegimeAndIntel(intelBundle, regime, scoredNews) {
  const isLive = intelBundle.source === "live_api";
  els.sosoSource.textContent = isLive ? "Live SoSoValue OpenAPI" : "Sandbox Snapshot (+ Live SoDEX)";
  els.sosoModeBadge.textContent = isLive
    ? `Live API (${intelBundle.rateLimit.remaining ?? "?"} rem)`
    : "Sandbox + Optional API Key";
  els.sosoModeBadge.className = `badge ${isLive ? "badge-live" : ""}`;
  els.regimeBadge.textContent = `${regime.regime} (${regime.score >= 0 ? "+" : ""}${regime.score})`;

  const weightsHtml = Object.entries(regime.targetWeights)
    .map(
      ([asset, w]) => `
      <div class="weight-bar"><span>${asset}</span><strong class="mono">${Math.round(w * 100)}%</strong></div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round(w * 100)}%"></div></div>
    `
    )
    .join("");

  els.regimePanel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <strong>Target Agentic Allocation: ${regime.regime}</strong>
      <span class="mono">Score ${regime.score}</span>
    </div>
    <div class="mini-metrics" style="margin-bottom:8px;">
      <span>3d US BTC ETF: <strong class="${regime.btc3dInflowUsd >= 0 ? "pos" : "neg"}">${fmtUsd(regime.btc3dInflowUsd)}</strong></span>
      <span>3d US ETH ETF: <strong class="${regime.eth3dInflowUsd >= 0 ? "pos" : "neg"}">${fmtUsd(regime.eth3dInflowUsd)}</strong></span>
      <span>Avg Perp APR: <strong>${regime.avgFundingAprPct}%</strong></span>
    </div>
    ${weightsHtml}
  `;

  els.newsFeed.innerHTML = scoredNews.items
    .map(
      (n) => `
      <div class="news-item">
        <div class="news-item-top">
          <strong>${n.title}</strong>
          <span class="mono ${n.sentiment > 0 ? "pos" : n.sentiment < 0 ? "neg" : ""}">${n.sentiment > 0 ? "+" : ""}${n.sentiment}</span>
        </div>
      </div>
    `
    )
    .join("");

  els.macroList.innerHTML = (intelBundle.macroEvents || [])
    .map(
      (ev) => `
      <div class="macro-item">
        <span class="mono">${ev.date}</span> &mdash; ${(ev.events || []).join(", ")}
      </div>
    `
    )
    .join("");
}

function renderBasisTable() {
  const q = state.filterText.trim().toLowerCase();
  const filtered = state.basisRows.filter(
    (r) =>
      !q ||
      r.base.toLowerCase().includes(q) ||
      r.perpSymbol.toLowerCase().includes(q) ||
      (r.spotSymbol || "").toLowerCase().includes(q)
  );
  els.basisTableBody.innerHTML = filtered
    .slice(0, 30)
    .map(
      (r) => `
      <tr>
        <td><strong>${r.base}</strong></td>
        <td class="mono">${r.spotSymbol || "--"}</td>
        <td class="mono">${r.perpSymbol}</td>
        <td class="mono">${r.spotPx !== null ? fmtPrice(r.spotPx) : "--"} / ${fmtPrice(r.perpPx)}</td>
        <td class="mono ${r.basisPct >= 0 ? "pos" : "neg"}">${r.basisPct}%</td>
        <td class="mono ${r.fundingAprPct >= 0 ? "pos" : "neg"}">${r.fundingAprPct}%</td>
        <td class="mono">${r.perpSpreadBps}</td>
        <td class="mono">${fmtUsd(r.quoteVolume24h, 0)}</td>
        <td><span class="sig-pill ${r.signalScore >= 40 ? "pos" : ""}">${r.signalScore}</span></td>
        <td>
          <button class="btn btn-secondary btn-xs" data-prefill="${r.spotSymbol || r.perpSymbol}">Stage</button>
        </td>
      </tr>
    `
    )
    .join("");

  els.basisTableBody.querySelectorAll("button[data-prefill]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sym = btn.getAttribute("data-prefill");
      if (state.spotSymbols.some((s) => s.name === sym)) {
        selectSymbol(sym);
      } else {
        const row = state.basisRows.find((r) => r.perpSymbol === sym);
        if (row) prefillOrderForm(row.perpSymbol, row.perpPx);
      }
    });
  });
}

function populateOrderDropdown() {
  const spotOpts = state.spotSymbols
    .filter((s) => s.status === "TRADING")
    .slice(0, 48)
    .map((s) => `<option value="spot:${s.name}">${s.displayName} (Spot ID ${s.id})</option>`)
    .join("");
  const perpsOpts = state.perpsSymbols
    .filter((s) => s.status === "TRADING")
    .slice(0, 25)
    .map((s) => `<option value="perps:${s.name}">${s.displayName} (Perp ID ${s.id})</option>`)
    .join("");
  els.orderSymbolSelect.innerHTML = spotOpts + perpsOpts;
}

function prefillOrderForm(symbolName, suggestedPx = null) {
  const isSpot = state.spotSymbols.some((s) => s.name === symbolName);
  const val = `${isSpot ? "spot" : "perps"}:${symbolName}`;
  if ([...els.orderSymbolSelect.options].some((o) => o.value === val)) {
    els.orderSymbolSelect.value = val;
  }
  const meta = isSpot
    ? state.spotSymbols.find((s) => s.name === symbolName)
    : state.perpsSymbols.find((s) => s.name === symbolName);
  const ticker = isSpot
    ? state.spotTickers.find((t) => t.symbol === symbolName)
    : state.perpsTickers.find((t) => t.symbol === symbolName);
  const rawPx = suggestedPx || Number(ticker?.askPx || ticker?.lastPx || 1);
  const prec = Number(meta?.pricePrecision ?? 4);
  const qtyPrec = Number(meta?.quantityPrecision ?? 2);
  const step = Number(meta?.stepSize || 0.01);
  const minQty = Math.max(Number(meta?.minQuantity || step), Math.ceil((25 / (rawPx || 1)) / step) * step);
  els.orderPrice.value = Number(rawPx).toFixed(prec);
  els.orderQuantity.value = minQty.toFixed(qtyPrec);
  evaluateAndRenderOrder(false);
}

async function selectSymbol(symbol) {
  state.selectedSymbol = symbol;
  renderSsiCards();
  const ticker = state.spotTickers.find((t) => t.symbol === symbol) || { symbol, lastPx: 0 };
  const meta = state.spotSymbols.find((s) => s.name === symbol);
  try {
    const [ob, klines] = await Promise.all([
      sodex.getSpotOrderbook(symbol, 15),
      sodex.getSpotKlines(symbol, "1h", 24),
    ]);
    const analysis = analyzeSpotToken(ticker, meta, ob, klines);
    state.selectedAnalysis = analysis;
    renderKlineChart(analysis);
    renderOrderbook(analysis);
    prefillOrderForm(symbol, analysis.orderbook.bestBid || analysis.lastPx);
  } catch (err) {
    els.bookHeightBadge.textContent = `err: ${err.message}`;
  }
}

function renderPaperLedger() {
  const entries = JSON.parse(localStorage.getItem(STORAGE_KEY_LEDGER) || "[]");
  if (entries.length === 0) {
    els.paperLedger.innerHTML = `<div class="panel-desc">No simulated / signed orders logged yet.</div>`;
    return;
  }
  els.paperLedger.innerHTML = entries
    .slice(0, 8)
    .map(
      (e) => `
      <div class="ledger-item">
        <div style="display:flex;justify-content:space-between;">
          <strong>${e.market.toUpperCase()} ${e.symbol} ${e.side}</strong>
          <span class="mono">${e.status}</span>
        </div>
        <div class="mono" style="font-size:11px;color:#8ea0be;">
          px=${e.price} qty=${e.quantity} ($${e.notionalUsd}) &bull; digest ${e.digest.slice(0, 14)}...
        </div>
      </div>
    `
    )
    .join("");
}

function evaluateAndRenderOrder(saveToLedger = true) {
  const [market, symbolName] = els.orderSymbolSelect.value.split(":");
  const meta =
    market === "spot"
      ? state.spotSymbols.find((s) => s.name === symbolName)
      : state.perpsSymbols.find((s) => s.name === symbolName);
  const ticker =
    market === "spot"
      ? state.spotTickers.find((t) => t.symbol === symbolName)
      : state.perpsTickers.find((t) => t.symbol === symbolName);
  const [orderType, tif] = els.orderTif.value.split(":");
  const ask = Number(ticker?.askPx || 0);
  const bid = Number(ticker?.bidPx || 0);
  const mid = (ask + bid) / 2 || Number(ticker?.lastPx || 0);
  const spreadBps = mid > 0 && ask > bid && bid > 0 ? Number((((ask - bid) / mid) * 10000).toFixed(2)) : 0;

  const risk = validatePreTradeRisk({
    symbolMeta: meta,
    side: els.orderSide.value,
    orderType,
    price: els.orderPrice.value,
    quantity: els.orderQuantity.value,
    spreadBps,
    quoteVolume24h: Number(ticker?.quoteVolume || 0),
    riskConfig: {
      maxNotionalUsd: Number(els.riskMaxNotional.value),
      maxSpreadBps: Number(els.riskMaxSpread.value),
      minVolume24hUsd: 50,
      confirmed: els.riskConfirmCheck.checked,
    },
  });

  els.riskChecksOut.innerHTML = risk.checks
    .map(
      (c) => `
      <div class="risk-row">
        <span>${c.passed ? "✅" : "❌"} ${c.name}</span>
        <span class="mono">${c.detail}</span>
      </div>
    `
    )
    .join("");

  if (!meta) return;
  const nonce = Date.now();
  const payload = buildBatchNewOrderPayload({
    accountID: Number(els.orderAccountId.value || 1010),
    symbolID: meta.id,
    clOrdID: `soso_${nonce}`,
    side: els.orderSide.value,
    orderType,
    timeInForce: tif,
    price: els.orderPrice.value,
    quantity: els.orderQuantity.value,
  });

  const digestObj = computeExchangeActionDigest({
    market,
    chainId: sodex.cfg.chainId,
    payload,
    nonce,
  });
  state.lastDigest = { ...digestObj, market, symbolName, risk };

  els.eip712Preview.textContent = JSON.stringify(
    {
      riskAllowed: risk.allowed,
      notionalUsd: risk.notionalUsd,
      payloadHash: digestObj.payloadHash,
      domainSeparator: digestObj.domainSeparator,
      eip712Digest: digestObj.digest,
      typedData: digestObj.typedData,
      canonicalActionPayload: payload,
    },
    null,
    2
  );

  if (saveToLedger && risk.allowed) {
    const entries = JSON.parse(localStorage.getItem(STORAGE_KEY_LEDGER) || "[]");
    entries.unshift({
      at: new Date().toISOString(),
      market,
      symbol: symbolName,
      side: els.orderSide.value,
      price: els.orderPrice.value,
      quantity: els.orderQuantity.value,
      notionalUsd: risk.notionalUsd,
      digest: digestObj.digest,
      status: "PAPER_APPROVED",
    });
    localStorage.setItem(STORAGE_KEY_LEDGER, JSON.stringify(entries.slice(0, 20)));
    renderPaperLedger();
  }
}

async function refreshAll() {
  els.sodexStatus.textContent = "Syncing...";
  try {
    const [spotSymbols, spotTickers, perpsSymbols, perpsTickers, vcStatus, intelBundle] = await Promise.all([
      sodex.getSpotSymbols(),
      sodex.getSpotTickers(),
      sodex.getPerpsSymbols(),
      sodex.getPerpsTickers(),
      sodex.getValueChainStatus().catch(() => ({ blockNumber: "RPC unreachable", chainId: sodex.cfg.chainId })),
      soso.loadIntelligenceBundle(),
    ]);

    state.spotSymbols = spotSymbols;
    state.spotTickers = spotTickers;
    state.perpsSymbols = perpsSymbols;
    state.perpsTickers = perpsTickers;

    els.sodexStatus.textContent = `${spotSymbols.length} Spot / ${perpsSymbols.length} Perps Live`;
    els.vcBlock.textContent = `#${vcStatus.blockNumber}`;
    els.vcChainId.textContent = `${vcStatus.chainId}`;

    // Pick live SSI & ecosystem symbols that exist on the selected network
    const availableSsi = SSI_SPOT_SYMBOLS.filter((sym) => spotTickers.some((t) => t.symbol === sym));
    const displaySyms = availableSsi.length > 0 ? availableSsi : spotTickers.slice(0, 5).map((t) => t.symbol);
    if (!displaySyms.includes(state.selectedSymbol)) {
      state.selectedSymbol = displaySyms[0] || spotTickers[0]?.symbol;
    }

    const ssiResults = await Promise.all(
      displaySyms.map(async (sym) => {
        const ticker = spotTickers.find((t) => t.symbol === sym);
        const meta = spotSymbols.find((s) => s.name === sym);
        const [ob, kl] = await Promise.all([
          sodex.getSpotOrderbook(sym, 5).catch(() => null),
          sodex.getSpotKlines(sym, "1h", 24).catch(() => []),
        ]);
        return analyzeSpotToken(ticker, meta, ob, kl);
      })
    );
    state.ssiAnalyses = ssiResults;
    state.basisRows = matchSpotPerpBasis(spotSymbols, spotTickers, perpsSymbols, perpsTickers);

    const scoredNews = scoreNewsFeed(intelBundle.hotNews);
    const regime = classifyMacroRegime({
      etfBtc: intelBundle.etfBtc,
      etfEth: intelBundle.etfEth,
      newsSentiment: scoredNews.average,
      basisRows: state.basisRows,
    });

    populateOrderDropdown();
    renderSsiCards();
    renderRegimeAndIntel(intelBundle, regime, scoredNews);
    renderBasisTable();
    await selectSymbol(state.selectedSymbol);
  } catch (err) {
    els.sodexStatus.textContent = `Error: ${err.message}`;
  }
}

els.networkSelect.addEventListener("change", () => {
  sodex.setNetwork(els.networkSelect.value);
  refreshAll();
});

els.saveKeyBtn.addEventListener("click", () => {
  const k = els.sosoApiKeyInput.value.trim();
  if (k) localStorage.setItem(STORAGE_KEY_API, k);
  else localStorage.removeItem(STORAGE_KEY_API);
  soso.setApiKey(k);
  refreshAll();
});

els.refreshBtn.addEventListener("click", refreshAll);
els.screenerFilter.addEventListener("input", () => {
  state.filterText = els.screenerFilter.value;
  renderBasisTable();
});
els.orderForm.addEventListener("submit", (e) => {
  e.preventDefault();
  evaluateAndRenderOrder(true);
});
els.signWalletBtn.addEventListener("click", async () => {
  evaluateAndRenderOrder(false);
  if (!window.ethereum || !state.lastDigest) {
    alert("No injected EVM wallet (e.g. MetaMask/Rabby) detected. Exact EIP-712 TypedData & Digest are shown in the preview box below for hardware/CLI signing.");
    return;
  }
  try {
    const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
    const sig = await window.ethereum.request({
      method: "eth_signTypedData_v4",
      params: [account, JSON.stringify(state.lastDigest.typedData)],
    });
    const sodexSig = formatSodexTypedSignature(sig, false);
    els.eip712Preview.textContent = `Signed by ${account}\nSoDEX X-API-Sign (0x01 prefixed):\n${sodexSig}\n\n` + els.eip712Preview.textContent;
  } catch (err) {
    alert(`Wallet signature cancelled/failed: ${err.message}`);
  }
});

renderPaperLedger();
refreshAll();
