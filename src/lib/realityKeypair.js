const CURVE25519_P = (1n << 255n) - 19n;
const X25519_A24 = 121665n;

function mod(value) {
  const result = value % CURVE25519_P;
  return result >= 0n ? result : result + CURVE25519_P;
}

function modPow(base, exponent) {
  let result = 1n;
  let power = mod(base);
  let exp = exponent;
  while (exp > 0n) {
    if (exp & 1n) result = mod(result * power);
    power = mod(power * power);
    exp >>= 1n;
  }
  return result;
}

function invert(value) {
  return modPow(value, CURVE25519_P - 2n);
}

function bytesToLittleEndian(bytes) {
  let value = 0n;
  for (let i = 0; i < bytes.length; i += 1) {
    value |= BigInt(bytes[i]) << BigInt(8 * i);
  }
  return value;
}

function littleEndianToBytes(value) {
  const bytes = new Uint8Array(32);
  let remaining = mod(value);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function clampPrivateKey(bytes) {
  const key = new Uint8Array(bytes);
  key[0] &= 248;
  key[31] &= 127;
  key[31] |= 64;
  return key;
}

function x25519(privateKey, publicU) {
  const scalar = bytesToLittleEndian(clampPrivateKey(privateKey));
  const x1 = bytesToLittleEndian(publicU);
  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;

  for (let t = 254; t >= 0; t -= 1) {
    const bit = (scalar >> BigInt(t)) & 1n;
    if ((swap ^ bit) === 1n) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = bit;

    const a = mod(x2 + z2);
    const aa = mod(a * a);
    const b = mod(x2 - z2);
    const bb = mod(b * b);
    const e = mod(aa - bb);
    const c = mod(x3 + z3);
    const d = mod(x3 - z3);
    const da = mod(d * a);
    const cb = mod(c * b);
    x3 = mod((da + cb) ** 2n);
    z3 = mod(x1 * mod((da - cb) ** 2n));
    x2 = mod(aa * bb);
    z2 = mod(e * mod(aa + X25519_A24 * e));
  }

  if (swap === 1n) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }

  return littleEndianToBytes(x2 * invert(z2));
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function generateLocalRealityKeypair() {
  const cryptoProvider = globalThis.crypto;
  if (typeof cryptoProvider?.getRandomValues !== "function") {
    throw new Error("crypto.getRandomValues unavailable");
  }

  const privateKey = clampPrivateKey(cryptoProvider.getRandomValues(new Uint8Array(32)));
  const basepoint = new Uint8Array(32);
  basepoint[0] = 9;
  const publicKey = x25519(privateKey, basepoint);

  return {
    privateKey: base64Url(privateKey),
    publicKey: base64Url(publicKey),
  };
}
