// Pre-Trade Risk Controls & Canonical SoDEX EIP-712 Action Builder.
// Matches https://docs.sodex.com/for-developers/developers/trading/authentication-and-signing.md

import { concatBytes, keccak256Bytes, keccak256Raw, keccak256Utf8, toBytes } from "./keccak256.mjs";

export const ORDER_SIDE = { BUY: 1, SELL: 2 };
export const ORDER_TYPE = { LIMIT: 1, MARKET: 2 };
export const TIME_IN_FORCE = { GTC: 1, FOK: 2, IOC: 3 };

function decimalStepAligned(valueStr, stepStr) {
  const v = Number(valueStr);
  const s = Number(stepStr);
  if (!Number.isFinite(v) || !Number.isFinite(s) || s <= 0) return false;
  const ratio = v / s;
  return Math.abs(ratio - Math.round(ratio)) < 1e-6;
}

export function validatePreTradeRisk({
  symbolMeta,
  side = "BUY",
  orderType = "LIMIT",
  price,
  quantity,
  spreadBps = 0,
  quoteVolume24h = 0,
  riskConfig = {},
}) {
  const cfg = {
    maxNotionalUsd: riskConfig.maxNotionalUsd ?? 1000,
    maxSpreadBps: riskConfig.maxSpreadBps ?? 75,
    minVolume24hUsd: riskConfig.minVolume24hUsd ?? 100,
    requireExplicitConfirm: riskConfig.requireExplicitConfirm ?? true,
    confirmed: Boolean(riskConfig.confirmed),
  };

  const checks = [];
  const px = Number(price);
  const qty = Number(quantity);
  const notionalUsd = Number.isFinite(px) && Number.isFinite(qty) ? px * qty : 0;

  checks.push({
    name: "Positive Quantity & Price",
    passed: qty > 0 && (orderType === "MARKET" || px > 0),
    detail: `qty=${qty}, price=${px}`,
  });

  const minNotional = Number(symbolMeta?.minNotional || 5);
  const maxNotionalSymbol = Number(symbolMeta?.maxNotional || 0);
  const capOk =
    notionalUsd >= minNotional &&
    notionalUsd <= cfg.maxNotionalUsd &&
    (maxNotionalSymbol === 0 || notionalUsd <= maxNotionalSymbol);

  checks.push({
    name: "Notional Within Risk Cap",
    passed: capOk,
    detail: `$${notionalUsd.toFixed(2)} (min $${minNotional}, desk cap $${cfg.maxNotionalUsd})`,
  });

  checks.push({
    name: "Orderbook Spread Guard",
    passed: spreadBps <= cfg.maxSpreadBps,
    detail: `${spreadBps} bps <= ${cfg.maxSpreadBps} bps max`,
  });

  checks.push({
    name: "24h Market Liquidity Floor",
    passed: quoteVolume24h >= cfg.minVolume24hUsd,
    detail: `$${quoteVolume24h.toLocaleString()} >= $${cfg.minVolume24hUsd.toLocaleString()}`,
  });

  if (symbolMeta?.tickSize && orderType === "LIMIT") {
    checks.push({
      name: "SoDEX Tick Size Alignment",
      passed: decimalStepAligned(String(price), String(symbolMeta.tickSize)),
      detail: `price=${price}, tickSize=${symbolMeta.tickSize}`,
    });
  }

  if (symbolMeta?.stepSize) {
    checks.push({
      name: "SoDEX Lot Step Alignment",
      passed: decimalStepAligned(String(quantity), String(symbolMeta.stepSize)),
      detail: `qty=${quantity}, stepSize=${symbolMeta.stepSize}`,
    });
  }

  if (cfg.requireExplicitConfirm) {
    checks.push({
      name: "Explicit Operator Confirmation",
      passed: cfg.confirmed,
      detail: cfg.confirmed ? "Confirmed by operator" : "Awaiting operator confirmation toggle",
    });
  }

  return {
    allowed: checks.every((c) => c.passed),
    notionalUsd: Number(notionalUsd.toFixed(2)),
    side,
    checks,
  };
}

// Canonical JSON serialization (Go json.Marshal style: omit undefined/null optional fields, exact key order).
export function canonicalSodexActionJson(payload) {
  return JSON.stringify(payload);
}

export function buildBatchNewOrderPayload({
  accountID,
  symbolID,
  clOrdID,
  side = "BUY",
  orderType = "LIMIT",
  timeInForce = "GTC",
  price,
  quantity,
  funds,
  builder,
}) {
  const item = {
    symbolID: Number(symbolID),
    clOrdID: String(clOrdID),
    side: typeof side === "number" ? side : ORDER_SIDE[String(side).toUpperCase()],
    type: typeof orderType === "number" ? orderType : ORDER_TYPE[String(orderType).toUpperCase()],
    timeInForce: typeof timeInForce === "number" ? timeInForce : TIME_IN_FORCE[String(timeInForce).toUpperCase()],
  };
  if (price !== undefined && price !== null && price !== "") item.price = String(price);
  if (quantity !== undefined && quantity !== null && quantity !== "") item.quantity = String(quantity);
  if (funds !== undefined && funds !== null && funds !== "") item.funds = String(funds);

  const params = {
    accountID: Number(accountID),
    orders: [item],
  };
  if (builder && builder.id) {
    params.builder = { id: Number(builder.id), fee: Number(builder.fee || 0) };
  }

  return {
    type: "batchNewOrder",
    params,
  };
}

function encodeUint256(val) {
  let n = BigInt(val);
  if (n < 0n) n = (1n << 256n) + n;
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function encodeAddress(addr) {
  const clean = addr.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error(`Invalid address: ${addr}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 20; i++) {
    out[12 + i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function encodeBytes32(hex32) {
  const clean = hex32.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error(`Invalid bytes32: ${hex32}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function computeEip712DomainSeparator({ name, version, chainId, verifyingContract }) {
  const typeHash = keccak256Raw(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
  );
  return keccak256Bytes(
    concatBytes(
      typeHash,
      keccak256Raw(name),
      keccak256Raw(version),
      encodeUint256(chainId),
      encodeAddress(verifyingContract)
    )
  );
}

export function computeExchangeActionDigest({ market = "spot", chainId = 286623, payload, nonce }) {
  const domainName = market === "perps" || market === "futures" ? "futures" : "spot";
  const verifyingContract = "0x0000000000000000000000000000000000000000";
  const canonicalJson = canonicalSodexActionJson(payload);
  const payloadHash = keccak256Utf8(canonicalJson);

  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ExchangeAction: [
        { name: "payloadHash", type: "bytes32" },
        { name: "nonce", type: "uint64" },
      ],
    },
    domain: {
      name: domainName,
      version: "1",
      chainId: Number(chainId),
      verifyingContract,
    },
    primaryType: "ExchangeAction",
    message: {
      payloadHash,
      nonce: Number(nonce),
    },
  };

  const domainSeparator = computeEip712DomainSeparator(typedData.domain);
  const actionTypeHash = keccak256Raw("ExchangeAction(bytes32 payloadHash,uint64 nonce)");
  const structHash = keccak256Bytes(
    concatBytes(actionTypeHash, encodeBytes32(payloadHash), encodeUint256(nonce))
  );
  const digest = keccak256Bytes(
    concatBytes(new Uint8Array([0x19, 0x01]), toBytes(domainSeparator), toBytes(structHash))
  );

  return {
    canonicalJson,
    payloadHash,
    domainSeparator,
    structHash,
    digest,
    signaturePrefix: "0x01",
    typedData,
  };
}

export function formatSodexTypedSignature(rawSigHex, isUniversalAction = false) {
  const clean = rawSigHex.replace(/^0x/, "");
  const prefix = isUniversalAction ? "02" : "01";
  return `0x${prefix}${clean}`;
}
