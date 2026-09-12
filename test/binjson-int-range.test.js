/**
 * The C encoder's safe-integer contract.
 *
 * Both decoders — this codec's C one and the JS reference — refuse an INT
 * outside the JS safe-integer range and abort the DECODE (BJ_ERR_INT_RANGE,
 * and a throw). The JS encoder never produces one: `Number.isSafeInteger`
 * picks INT and every other number takes the FLOAT branch. `bj_put_int` used
 * to write INT at any magnitude, so a C producer could build a document that
 * no conformant reader would read — and because the refusal lands on the whole
 * decode rather than the one value, a single such integer cost the whole
 * document. It was found that way: `big: 9007199254740992` in a document's
 * front matter made that document vanish from every query in mdy-docs' C
 * engine, with the insert reporting success.
 *
 * Neither the JS encoder nor the WASM binding can reach bj_put_int with such a
 * value — both guard with isSafeInteger first — so this drives the exported C
 * builder directly. That is the only caller shape the bug lives in, and the
 * only one that can hold it fixed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import createBinjsonModule from '../lib/binjson.wasm.mjs';
import { TYPE, decode, ready } from '../wasm/binjson-wasm.js';

let M;
beforeAll(async () => {
  /* Two modules: `M` is a raw instance this drives directly, and the
     binding's own has to be initialised for decode() to work. */
  M = await createBinjsonModule();
  await ready();
});

/** Encode one scalar by calling the C builder, as a C caller would. */
function putIntRaw(v) {
  expect(M._bjw_enc_reset()).toBe(0);
  const rc = M._bjw_put_int(v);
  if (rc !== 0) return { rc, bytes: null };
  const len = M._bjw_enc_finish();
  expect(len).toBeGreaterThan(0);
  const ptr = M._bjw_enc_ptr();
  return { rc: 0, bytes: M.HEAPU8.slice(ptr, ptr + len) };
}

describe('C encoder: integers outside the JS safe range', () => {
  const SAFE = 9007199254740991;      // 2^53 - 1

  it('writes a safe integer as INT', () => {
    const { rc, bytes } = putIntRaw(SAFE);
    expect(rc).toBe(0);
    expect(bytes[0]).toBe(TYPE.INT);
    expect(decode(bytes)).toBe(SAFE);
  });

  it('writes one past the range as FLOAT, not INT', () => {
    const { rc, bytes } = putIntRaw(SAFE + 1);
    expect(rc).toBe(0);
    expect(bytes[0]).toBe(TYPE.FLOAT);
  });

  it('...and what it writes decodes, which an INT would not have', () => {
    const { bytes } = putIntRaw(SAFE + 1);
    expect(() => decode(bytes)).not.toThrow();
    expect(decode(bytes)).toBe(SAFE + 1);
  });

  it('does the same below the negative bound', () => {
    const { rc, bytes } = putIntRaw(-SAFE - 1);
    expect(rc).toBe(0);
    expect(bytes[0]).toBe(TYPE.FLOAT);
    expect(decode(bytes)).toBe(-SAFE - 1);
  });

  it('agrees with the reference encoder byte for byte', async () => {
    const js = await import('../js/binjson.js');
    for (const v of [SAFE, SAFE + 1, -SAFE - 1, 1e17, 0, -1, 1.5]) {
      const { bytes } = putIntRaw(Number.isInteger(v) ? v : 0);
      if (!Number.isInteger(v)) continue;
      expect(Array.from(bytes)).toEqual(Array.from(js.encode(v)));
    }
  });

  /* A document, not a scalar: the shape the bug was found in, where the cost
     landed on every OTHER key rather than on the number. */
  it('a document carrying one still decodes whole', () => {
    expect(M._bjw_enc_reset()).toBe(0);
    expect(M._bjw_begin_object()).toBe(0);
    const key = (s) => {
      const b = new TextEncoder().encode(s);
      const p = M._malloc(b.length);
      M.HEAPU8.set(b, p);
      expect(M._bjw_put_key(p, b.length)).toBe(0);
      M._free(p);
    };
    const str = (s) => {
      const b = new TextEncoder().encode(s);
      const p = M._malloc(b.length);
      M.HEAPU8.set(b, p);
      expect(M._bjw_put_string(p, b.length)).toBe(0);
      M._free(p);
    };
    key('title'); str('Fine');
    key('big');   expect(M._bjw_put_int(SAFE + 1)).toBe(0);
    key('also');  str('Fine too');
    expect(M._bjw_end_object()).toBe(0);
    const len = M._bjw_enc_finish();
    const ptr = M._bjw_enc_ptr();
    const bytes = M.HEAPU8.slice(ptr, ptr + len);

    const doc = decode(bytes);
    expect(doc.title).toBe('Fine');
    expect(doc.also).toBe('Fine too');
    expect(doc.big).toBe(SAFE + 1);
  });
});

describe('C encoder: pointer offsets outside the safe range', () => {
  /* The reference THROWS for a Pointer past MAX_SAFE_INTEGER rather than
     narrowing, because a rounded offset points at the wrong place. So this
     refuses instead of falling back. */
  it('refuses rather than writing an offset no reader accepts', () => {
    expect(M._bjw_enc_reset()).toBe(0);
    expect(M._bjw_put_pointer(9007199254740992)).not.toBe(0);
  });

  it('still accepts one inside the range', () => {
    expect(M._bjw_enc_reset()).toBe(0);
    expect(M._bjw_put_pointer(4096)).toBe(0);
  });
});
