// Live SoDEX REST & ValueChain EVM JSON-RPC client (Mainnet & Testnet, zero API key required for reads).

export const NETWORKS = {
  mainnet: {
    label: "ValueChain Mainnet",
    chainId: 286623,
    publicApi: "https://mainnet-gw.sodex.dev/api/v1",
    spotApi: "https://mainnet-gw.sodex.dev/api/v1/spot",
    perpsApi: "https://mainnet-gw.sodex.dev/api/v1/perps",
    rpcUrl: "https://mainnet.valuechain.xyz",
    explorer: "https://main-scan.valuechain.xyz",
  },
  testnet: {
    label: "ValueChain Testnet",
    chainId: 138565,
    publicApi: "https://testnet-gw.sodex.dev/api/v1",
    spotApi: "https://testnet-gw.sodex.dev/api/v1/spot",
    perpsApi: "https://testnet-gw.sodex.dev/api/v1/perps",
    rpcUrl: "https://testnet.valuechain.xyz",
    explorer: "https://test-scan.valuechain.xyz",
  },
};

export const SSI_SPOT_SYMBOLS = [
  "vDEFIssi_vUSDC",
  "vUSSI_vUSDC",
  "vMAG7ssi_vUSDC",
  "vMEMEssi_vUSDC",
  "WSOSO_vUSDC",
];

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { Accept: "application/json", ...(options.headers || {}) },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} for ${url}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

export class SodexClient {
  constructor(network = "mainnet") {
    this.setNetwork(network);
  }

  setNetwork(network) {
    if (!NETWORKS[network]) throw new Error(`Unknown network: ${network}`);
    this.networkName = network;
    this.cfg = NETWORKS[network];
  }

  async getSpotSymbols() {
    const res = await fetchJson(`${this.cfg.spotApi}/markets/symbols`);
    if (res.code !== 0) throw new Error(`SoDEX spot symbols error: ${res.code}`);
    return res.data || [];
  }

  async getSpotTickers(symbol = null) {
    const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
    const res = await fetchJson(`${this.cfg.spotApi}/markets/tickers${q}`);
    if (res.code !== 0) throw new Error(`SoDEX spot tickers error: ${res.code}`);
    return res.data || [];
  }

  async getSpotOrderbook(symbol, limit = 15) {
    const res = await fetchJson(`${this.cfg.spotApi}/markets/${encodeURIComponent(symbol)}/orderbook?limit=${limit}`);
    if (res.code !== 0) throw new Error(`SoDEX spot orderbook error: ${res.code}`);
    return res.data;
  }

  async getSpotKlines(symbol, interval = "1h", limit = 24) {
    const res = await fetchJson(
      `${this.cfg.spotApi}/markets/${encodeURIComponent(symbol)}/klines?interval=${encodeURIComponent(interval)}&limit=${limit}`
    );
    if (res.code !== 0) throw new Error(`SoDEX spot klines error: ${res.code}`);
    return res.data || [];
  }

  async getSpotTrades(symbol, limit = 12) {
    const res = await fetchJson(`${this.cfg.spotApi}/markets/${encodeURIComponent(symbol)}/trades?limit=${limit}`);
    if (res.code !== 0) throw new Error(`SoDEX spot trades error: ${res.code}`);
    return res.data || [];
  }

  async getPerpsSymbols() {
    const res = await fetchJson(`${this.cfg.perpsApi}/markets/symbols`);
    if (res.code !== 0) throw new Error(`SoDEX perps symbols error: ${res.code}`);
    return res.data || [];
  }

  async getPerpsTickers(symbol = null) {
    const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
    const res = await fetchJson(`${this.cfg.perpsApi}/markets/tickers${q}`);
    if (res.code !== 0) throw new Error(`SoDEX perps tickers error: ${res.code}`);
    return res.data || [];
  }

  async getPerpsOrderbook(symbol, limit = 15) {
    const res = await fetchJson(`${this.cfg.perpsApi}/markets/${encodeURIComponent(symbol)}/orderbook?limit=${limit}`);
    if (res.code !== 0) throw new Error(`SoDEX perps orderbook error: ${res.code}`);
    return res.data;
  }

  async getValueChainStatus() {
    const callRpc = async (method) =>
      fetchJson(this.cfg.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
      });

    const [chainHex, blockHex, gasHex] = await Promise.all([
      callRpc("eth_chainId"),
      callRpc("eth_blockNumber"),
      callRpc("eth_gasPrice"),
    ]);
    return {
      network: this.networkName,
      rpcUrl: this.cfg.rpcUrl,
      chainId: parseInt(chainHex.result, 16),
      blockNumber: parseInt(blockHex.result, 16),
      gasPriceWei: BigInt(gasHex.result).toString(),
    };
  }
}
