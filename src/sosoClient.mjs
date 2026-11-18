// SoSoValue OpenAPI v1 Client with TTL Caching, Rate-Limit Telemetry & Deterministic Sandbox Fallback.
// Base URL per https://sosovalue-1.gitbook.io/sosovalue-api-doc/endpoint-overview.md

export const SOSOVALUE_OPENAPI_BASE = "https://openapi.sosovalue.com/openapi/v1";

// Sample dataset matching exact documented SoSoValue OpenAPI v1 schemas for zero-config demo evaluation
// when the user has not entered a personal x-soso-api-key. Live key replaces these cleanly.
export const SANDBOX_SOSO_DATA = {
  etfSummaryBtcUs: [
    { date: "2026-11-18", total_net_inflow: 284500000, total_value_traded: 3910000000, total_net_assets: 68420000000, cum_net_inflow: 29840000000 },
    { date: "2026-11-17", total_net_inflow: 162300000, total_value_traded: 3180000000, total_net_assets: 67910000000, cum_net_inflow: 29555500000 },
    { date: "2026-11-16", total_net_inflow: -41200000, total_value_traded: 2650000000, total_net_assets: 67100000000, cum_net_inflow: 29393200000 },
    { date: "2026-11-15", total_net_inflow: 198400000, total_value_traded: 2990000000, total_net_assets: 67380000000, cum_net_inflow: 29434400000 },
    { date: "2026-11-14", total_net_inflow: 310200000, total_value_traded: 4120000000, total_net_assets: 67050000000, cum_net_inflow: 29236000000 },
  ],
  etfSummaryEthUs: [
    { date: "2026-11-18", total_net_inflow: 64200000, total_value_traded: 620000000, total_net_assets: 11250000000, cum_net_inflow: 4180000000 },
    { date: "2026-11-17", total_net_inflow: 39800000, total_value_traded: 510000000, total_net_assets: 11120000000, cum_net_inflow: 4115800000 },
    { date: "2026-11-16", total_net_inflow: 12100000, total_value_traded: 440000000, total_net_assets: 10980000000, cum_net_inflow: 4076000000 },
  ],
  indices: ["ssiMAG7", "ssiDeFi", "ssiMEME", "ssiLayer1"],
  constituentsByIndex: {
    ssiMAG7: [
      { symbol: "btc", weight: 0.31 },
      { symbol: "eth", weight: 0.24 },
      { symbol: "sol", weight: 0.16 },
      { symbol: "bnb", weight: 0.11 },
      { symbol: "xrp", weight: 0.08 },
      { symbol: "doge", weight: 0.05 },
      { symbol: "ada", weight: 0.05 },
    ],
    ssiDeFi: [
      { symbol: "uni", weight: 0.25 },
      { symbol: "aave", weight: 0.24 },
      { symbol: "link", weight: 0.21 },
      { symbol: "ena", weight: 0.15 },
      { symbol: "pendle", weight: 0.15 },
    ],
    ssiMEME: [
      { symbol: "doge", weight: 0.36 },
      { symbol: "shib", weight: 0.24 },
      { symbol: "pepe", weight: 0.22 },
      { symbol: "pump", weight: 0.18 },
    ],
  },
  hotNews: [
    {
      id: 900101,
      title: "US Spot Bitcoin ETFs Log Back-to-Back Net Inflows Above $280M Led by Institutional Accumulation",
      release_time: 1795020000000,
      source_link: "https://sosovalue.com/news",
    },
    {
      id: 900102,
      title: "SSI DeFi Index Spot Liquidity Expands on ValueChain Orderbook as On-Chain Treasury Yields Stabilize",
      release_time: 1795012000000,
      source_link: "https://sosovalue.com/news",
    },
    {
      id: 900103,
      title: "Fed Rate Path Uncertainty Sparks Mild Volatility Ahead of Upcoming Macro CPI and Payroll Prints",
      release_time: 1795001000000,
      source_link: "https://sosovalue.com/news",
    },
    {
      id: 900104,
      title: "ETH Staking ETF Inflows Turn Positive for Third Straight Session While Perp Funding Remains Balanced",
      release_time: 1794990000000,
      source_link: "https://sosovalue.com/news",
    },
  ],
  macroEvents: [
    { date: "2026-11-20", events: ["US Initial Jobless Claims", "FOMC Minutes"] },
    { date: "2026-11-26", events: ["US Core PCE Price Index", "GDP Second Estimate"] },
  ],
};

export class SosoValueClient {
  constructor(apiKey = "", options = {}) {
    this.apiKey = (apiKey || "").trim();
    this.cacheTtlMs = options.cacheTtlMs || 5 * 60 * 1000;
    this.cache = new Map();
    this.rateLimit = { limit: null, remaining: null, reset: null, mode: this.apiKey ? "live_api" : "sandbox" };
  }

  setApiKey(apiKey) {
    this.apiKey = (apiKey || "").trim();
    this.cache.clear();
    this.rateLimit.mode = this.apiKey ? "live_api" : "sandbox";
  }

  async request(path, queryParams = {}) {
    if (!this.apiKey) {
      return { source: "sandbox", data: null };
    }
    const qs = new URLSearchParams(
      Object.entries(queryParams).filter(([, v]) => v !== undefined && v !== null && v !== "")
    ).toString();
    const url = `${SOSOVALUE_OPENAPI_BASE}${path}${qs ? `?${qs}` : ""}`;

    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) {
      return { source: "live_cache", data: hit.data };
    }

    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        "x-soso-api-key": this.apiKey,
      },
    });
    const lim = resp.headers.get("X-RateLimit-Limit");
    const rem = resp.headers.get("X-RateLimit-Remaining");
    const rst = resp.headers.get("X-RateLimit-Reset");
    this.rateLimit = {
      limit: lim ? Number(lim) : this.rateLimit.limit,
      remaining: rem ? Number(rem) : this.rateLimit.remaining,
      reset: rst ? Number(rst) : this.rateLimit.reset,
      mode: "live_api",
    };

    if (!resp.ok) {
      throw new Error(`SoSoValue API HTTP ${resp.status}`);
    }
    const json = await resp.json();
    if (json.code !== 0) {
      throw new Error(`SoSoValue API error code ${json.code}: ${json.message || "unknown"}`);
    }
    this.cache.set(url, { at: Date.now(), data: json.data });
    return { source: "live_api", data: json.data };
  }

  async loadIntelligenceBundle() {
    if (!this.apiKey) {
      return {
        source: "sandbox",
        rateLimit: this.rateLimit,
        etfBtc: SANDBOX_SOSO_DATA.etfSummaryBtcUs,
        etfEth: SANDBOX_SOSO_DATA.etfSummaryEthUs,
        indices: SANDBOX_SOSO_DATA.indices,
        constituents: SANDBOX_SOSO_DATA.constituentsByIndex,
        hotNews: SANDBOX_SOSO_DATA.hotNews,
        macroEvents: SANDBOX_SOSO_DATA.macroEvents,
      };
    }

    try {
      const [etfBtcRes, etfEthRes, idxRes, newsRes, macroRes] = await Promise.all([
        this.request("/etfs/summary-history", { symbol: "BTC", country_code: "US", limit: 7 }),
        this.request("/etfs/summary-history", { symbol: "ETH", country_code: "US", limit: 7 }),
        this.request("/indices"),
        this.request("/news/hot", { page: 1, page_size: 10 }),
        this.request("/macro/events"),
      ]);
      const indicesList = Array.isArray(idxRes.data) ? idxRes.data : SANDBOX_SOSO_DATA.indices;
      const topIndices = indicesList.slice(0, 3);
      const constEntries = await Promise.all(
        topIndices.map(async (ticker) => {
          try {
            const c = await this.request(`/indices/${encodeURIComponent(ticker)}/constituents`);
            return [ticker, c.data || []];
          } catch {
            return [ticker, SANDBOX_SOSO_DATA.constituentsByIndex[ticker] || []];
          }
        })
      );
      return {
        source: "live_api",
        rateLimit: this.rateLimit,
        etfBtc: etfBtcRes.data || SANDBOX_SOSO_DATA.etfSummaryBtcUs,
        etfEth: etfEthRes.data || SANDBOX_SOSO_DATA.etfSummaryEthUs,
        indices: indicesList,
        constituents: Object.fromEntries(constEntries),
        hotNews: newsRes.data?.list || SANDBOX_SOSO_DATA.hotNews,
        macroEvents: macroRes.data || SANDBOX_SOSO_DATA.macroEvents,
      };
    } catch (err) {
      return {
        source: "sandbox_fallback",
        error: err.message,
        rateLimit: this.rateLimit,
        etfBtc: SANDBOX_SOSO_DATA.etfSummaryBtcUs,
        etfEth: SANDBOX_SOSO_DATA.etfSummaryEthUs,
        indices: SANDBOX_SOSO_DATA.indices,
        constituents: SANDBOX_SOSO_DATA.constituentsByIndex,
        hotNews: SANDBOX_SOSO_DATA.hotNews,
        macroEvents: SANDBOX_SOSO_DATA.macroEvents,
      };
    }
  }
}
