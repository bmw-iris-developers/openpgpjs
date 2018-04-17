/**
 * @fileoverview This module implements AES-CMAC on top of
 * native AES-CBC using either the WebCrypto API or Node.js' crypto API.
 * @requires asmcrypto.js
 * @requires util
 * @module crypto/cmac
 */

import { AES_CBC } from 'asmcrypto.js/src/aes/cbc/exports';
import util from '../util';

const webCrypto = util.getWebCryptoAll();
const nodeCrypto = util.getNodeCrypto();
const Buffer = util.getNodeBuffer();


/**
 * This implementation of CMAC is based on the description of OMAC in
 * http://web.cs.ucdavis.edu/~rogaway/papers/eax.pdf. As per that
 * document:
 *
 * We have made a small modification to the OMAC algorithm as it was
 * originally presented, changing one of its two constants.
 * Specifically, the constant 4 at line 85 was the constant 1/2 (the
 * multiplicative inverse of 2) in the original definition of OMAC [14].
 * The OMAC authors indicate that they will promulgate this modification
 * [15], which slightly simplifies implementations.
 */

const blockLength = 16;


/**
 * xor `padding` into the end of `data`. This function implements "the
 * operation xor→ [which] xors the shorter string into the end of longer
 * one". Since data is always as least as long as padding, we can
 * simplify the implementation.
 * @param {Uint8Array} data
 * @param {Uint8Array} padding
 */
function rightXorMut(data, padding) {
  const offset = data.length - blockLength;
  for (let i = 0; i < blockLength; i++) {
    data[i + offset] ^= padding[i];
  }
  return data;
}

/**
 * 2L = L<<1 if the first bit of L is 0 and 2L = (L<<1) xor (0^120 ||
 * 10000111) otherwise, where L<<1 means the left shift of L by one
 * position (the first bit vanishing and a zero entering into the last
 * bit). The value of 4L is simply 2(2L). We warn that to avoid side-
 * channel attacks one must implement the doubling operation in a
 * constant-time manner.
 * @param {Uint8Array} data
 */
function mul2(data) {
  const t = data[0] & 0x80;
  for (let i = 0; i < 15; i++) {
    data[i] = (data[i] << 1) ^ ((data[i + 1] & 0x80) ? 1 : 0);
  }
  data[15] = (data[15] << 1) ^ (t ? 0x87 : 0);
  return data;
}

function pad(data, padding, padding2) {
  // if |M| in {n, 2n, 3n, ...}
  if (data.length % blockLength === 0) {
    // then return M xor→ B,
    return rightXorMut(data, padding);
  }
  // else return (M || 10^(n−1−(|M| mod n))) xor→ P
  const padded = new Uint8Array(data.length + (blockLength - data.length % blockLength));
  padded.set(data);
  padded[data.length] = 0b10000000;
  return rightXorMut(padded, padding2);
}

const zeroBlock = new Uint8Array(blockLength);

export default async function CMAC(key) {
  const cbc = await CBC(key);

  // L ← E_K(0^n); B ← 2L; P ← 4L
  const padding = mul2(await cbc(zeroBlock));
  const padding2 = mul2(padding.slice());

  return async function(data) {
    // return CBC_K(pad(M; B, P))
    return (await cbc(pad(data, padding, padding2))).subarray(-blockLength);
  };
}

async function CBC(key) {
  if (util.getWebCryptoAll() && key.length !== 24) { // WebCrypto (no 192 bit support) see: https://www.chromium.org/blink/webcrypto#TOC-AES-support
    key = await webCrypto.importKey('raw', key, { name: 'AES-CBC', length: key.length * 8 }, false, ['encrypt']);
    return async function(pt) {
      const ct = await webCrypto.encrypt({ name: 'AES-CBC', iv: zeroBlock, length: blockLength * 8 }, key, pt);
      return new Uint8Array(ct).subarray(0, ct.byteLength - blockLength);
    };
  }
  if (util.getNodeCrypto()) { // Node crypto library
    key = new Buffer(key);
    return async function(pt) {
      pt = new Buffer(pt);
      const en = new nodeCrypto.createCipheriv('aes-' + (key.length * 8) + '-cbc', key, zeroBlock);
      const ct = en.update(pt);
      return new Uint8Array(ct);
    };
  }
  // asm.js fallback
  return async function(pt) {
    return AES_CBC.encrypt(pt, key, false, zeroBlock);
  };
}
