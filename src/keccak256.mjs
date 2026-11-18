// Zero-dependency Keccak-256 (Ethereum / EIP-712) implementation for Browser ESM & Node.js.
// Tested against eth_utils.keccak / Ethereum test vectors in tests/all.test.mjs.

const KECCAK_ROUNDS = 24;
const RC_HIGH = [
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000,
  0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
];
const RC_LOW = [
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001,
  0x80008081, 0x00008009, 0x0000008a, 0x00000088, 0x80008009, 0x8000000a,
  0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080,
  0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
];
const RHO = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43,
  25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];
const PI = [
  0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2,
  12, 22, 23, 8, 18, 3, 13, 14, 24, 9, 19, 4,
];

function rotl64(hi, lo, offset) {
  const s = offset % 64;
  if (s === 0) return [hi, lo];
  if (s < 32) {
    return [
      ((hi << s) | (lo >>> (32 - s))) >>> 0,
      ((lo << s) | (hi >>> (32 - s))) >>> 0,
    ];
  }
  const r = s - 32;
  return [
    ((lo << r) | (hi >>> (32 - r))) >>> 0,
    ((hi << r) | (lo >>> (32 - r))) >>> 0,
  ];
}

function keccakF1600(stateHi, stateLo) {
  const cHi = new Uint32Array(5);
  const cLo = new Uint32Array(5);
  const dHi = new Uint32Array(5);
  const dLo = new Uint32Array(5);
  const bHi = new Uint32Array(25);
  const bLo = new Uint32Array(25);

  for (let round = 0; round < KECCAK_ROUNDS; round++) {
    for (let x = 0; x < 5; x++) {
      cHi[x] = (stateHi[x] ^ stateHi[x + 5] ^ stateHi[x + 10] ^ stateHi[x + 15] ^ stateHi[x + 20]) >>> 0;
      cLo[x] = (stateLo[x] ^ stateLo[x + 5] ^ stateLo[x + 10] ^ stateLo[x + 15] ^ stateLo[x + 20]) >>> 0;
    }
    for (let x = 0; x < 5; x++) {
      const [rHi, rLo] = rotl64(cHi[(x + 1) % 5], cLo[(x + 1) % 5], 1);
      dHi[x] = (cHi[(x + 4) % 5] ^ rHi) >>> 0;
      dLo[x] = (cLo[(x + 4) % 5] ^ rLo) >>> 0;
    }
    for (let i = 0; i < 25; i++) {
      const x = i % 5;
      const tHi = (stateHi[i] ^ dHi[x]) >>> 0;
      const tLo = (stateLo[i] ^ dLo[x]) >>> 0;
      const [rHi, rLo] = rotl64(tHi, tLo, RHO[i]);
      const dst = PI[i];
      bHi[dst] = rHi;
      bLo[dst] = rLo;
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const i = y + x;
        const i1 = y + ((x + 1) % 5);
        const i2 = y + ((x + 2) % 5);
        stateHi[i] = (bHi[i] ^ (~bHi[i1] & bHi[i2])) >>> 0;
        stateLo[i] = (bLo[i] ^ (~bLo[i1] & bLo[i2])) >>> 0;
      }
    }
    stateHi[0] = (stateHi[0] ^ RC_HIGH[round]) >>> 0;
    stateLo[0] = (stateLo[0] ^ RC_LOW[round]) >>> 0;
  }
}

export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === "string") {
    if (input.startsWith("0x") && /^0x([0-9a-fA-F]{2})+$/.test(input)) {
      const hex = input.slice(2);
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return out;
    }
    return new TextEncoder().encode(input);
  }
  throw new TypeError("Unsupported input type for keccak256Bytes");
}

export function keccak256Raw(bytesInput) {
  const data = bytesInput instanceof Uint8Array ? bytesInput : toBytes(bytesInput);
  const rateBytes = 136; // 1088 bits for Keccak-256
  const stateHi = new Uint32Array(25);
  const stateLo = new Uint32Array(25);

  const block = new Uint8Array(rateBytes);
  let offset = 0;
  while (offset + rateBytes <= data.length) {
    block.set(data.subarray(offset, offset + rateBytes));
    absorbBlock(stateHi, stateLo, block, rateBytes);
    keccakF1600(stateHi, stateLo);
    offset += rateBytes;
  }

  block.fill(0);
  const rem = data.length - offset;
  block.set(data.subarray(offset));
  block[rem] ^= 0x01;
  block[rateBytes - 1] ^= 0x80;
  absorbBlock(stateHi, stateLo, block, rateBytes);
  keccakF1600(stateHi, stateLo);

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    const lo = stateLo[i];
    const hi = stateHi[i];
    const base = i * 8;
    out[base] = lo & 0xff;
    out[base + 1] = (lo >>> 8) & 0xff;
    out[base + 2] = (lo >>> 16) & 0xff;
    out[base + 3] = (lo >>> 24) & 0xff;
    out[base + 4] = hi & 0xff;
    out[base + 5] = (hi >>> 8) & 0xff;
    out[base + 6] = (hi >>> 16) & 0xff;
    out[base + 7] = (hi >>> 24) & 0xff;
  }
  return out;
}

function absorbBlock(stateHi, stateLo, block, rateBytes) {
  const words = rateBytes / 8;
  for (let i = 0; i < words; i++) {
    const b = i * 8;
    const lo = (block[b] | (block[b + 1] << 8) | (block[b + 2] << 16) | (block[b + 3] << 24)) >>> 0;
    const hi = (block[b + 4] | (block[b + 5] << 8) | (block[b + 6] << 16) | (block[b + 7] << 24)) >>> 0;
    stateLo[i] = (stateLo[i] ^ lo) >>> 0;
    stateHi[i] = (stateHi[i] ^ hi) >>> 0;
  }
}

export function keccak256Utf8(text) {
  return bytesToHex(keccak256Raw(new TextEncoder().encode(text)));
}

export function keccak256Bytes(bytesInput) {
  return bytesToHex(keccak256Raw(bytesInput));
}

export function bytesToHex(bytes) {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function concatBytes(...arrays) {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}
