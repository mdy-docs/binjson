/**
 * binjson-wasm.js — standalone WASM-backed binjson codec, buildable and
 * usable independently of the rest of this repo (see build-wasm.sh in
 * this package's root, which produces lib/binjson.wasm(.mjs)).
 *
 * Extracted verbatim from the parent project's src/binjson-wasm.js (its
 * own combined WASM module bundles binjson together with several other
 * data structures for its own use, and keeps its own copy of this same
 * codec logic rather than depending on this package) -- this is the
 * subset of that file that is actually binjson: encode/decode/valueSize
 * and BinJsonFile. Nothing else in this file (or the tree/index/log
 * wrappers it was extracted from) is reachable from here.
 *
 * The WASM module loads asynchronously; call and await `ready()` once
 * before using the synchronous codec.
 */
import createBinjsonModule from '../lib/binjson.wasm.mjs';
import {
  TYPE,
  ObjectId,
  Pointer,
  MemoryHandle,
  exists,
  deleteFile,
  getFileHandle
} from '../js/binjson.js';

// Event tags — must match the BJW_EV_* constants in src/binjson_wasm.c.
const EV = {
  NULL: 0, FALSE: 1, TRUE: 2, INT: 3, FLOAT: 4, STRING: 5, OID: 6,
  DATE: 7, POINTER: 8, BINARY: 9, ARR_BEGIN: 10, ARR_END: 11,
  OBJ_BEGIN: 12, KEY: 13, OBJ_END: 14
};

// Error codes — must match the BJ_ERR_* constants in include/binjson.h.
const ERR = {
  [-1]: 'out of memory',
  [-2]: 'builder state error',
  [-3]: 'Unexpected end of data',
  [-4]: 'Unknown type byte',
  [-5]: 'Decoded integer exceeds safe range',
  [-6]: 'Pointer offset out of valid range',
  [-7]: 'Maximum nesting depth exceeded',
  [-8]: 'Structural invariant violated',
  [-9]: 'Argument out of range',
  [-10]: 'Duplicate _id',
  [-11]: 'replaceOne cannot change the _id of an existing document',
  [-12]: 'Duplicate key: a unique index already has a document with these field values'
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let Module = null;
let readyPromise = null;

/**
 * Instantiate the WASM module. Idempotent; returns a promise that resolves when
 * encode/decode are usable. Must be awaited before the first encode/decode.
 */
function ready() {
  if (!readyPromise) {
    readyPromise = createBinjsonModule().then((m) => { Module = m; return m; });
  }
  return readyPromise;
}

/** True once the module is instantiated and encode/decode may be called. */
function isReady() {
  return Module !== null;
}

function requireModule() {
  if (!Module) {
    throw new Error('binjson-wasm not initialized: await ready() before encode/decode');
  }
  return Module;
}

function codeError(code, context) {
  const msg = ERR[code] || `binjson error ${code}`;
  return new Error(context ? `${msg} (${context})` : msg);
}

function check(code) {
  if (code !== 0) throw codeError(code);
}

/**
 * Copy `bytes` into the WASM heap, invoke `fn(ptr, len)`, then free. The C
 * builder copies immediately, so the scratch allocation is safe to release.
 */
function withBytes(M, bytes, fn) {
  const n = bytes.length;
  const ptr = n ? M._malloc(n) : 0;
  if (n) M.HEAPU8.set(bytes, ptr);
  try {
    return fn(ptr, n);
  } finally {
    if (n) M._free(ptr);
  }
}

function writeValue(M, val) {
  if (val === null) { check(M._bjw_put_null()); return; }
  if (val === false) { check(M._bjw_put_bool(0)); return; }
  if (val === true) { check(M._bjw_put_bool(1)); return; }

  if (val instanceof ObjectId) {
    withBytes(M, val.toBytes(), (p) => check(M._bjw_put_oid(p)));
    return;
  }
  if (val instanceof Date) { check(M._bjw_put_date(val.getTime())); return; }
  if (val instanceof Pointer) { check(M._bjw_put_pointer(val.offset)); return; }
  if (val instanceof Uint8Array) {
    withBytes(M, val, (p, n) => check(M._bjw_put_binary(p, n)));
    return;
  }

  const t = typeof val;
  if (t === 'number') {
    if (Number.isInteger(val) && Number.isSafeInteger(val)) check(M._bjw_put_int(val));
    else check(M._bjw_put_float(val));
    return;
  }
  if (t === 'string') {
    withBytes(M, textEncoder.encode(val), (p, n) => check(M._bjw_put_string(p, n)));
    return;
  }
  if (Array.isArray(val)) {
    check(M._bjw_begin_array());
    for (const item of val) writeValue(M, item);
    check(M._bjw_end_array());
    return;
  }
  if (t === 'object') {
    check(M._bjw_begin_object());
    for (const key of Object.keys(val)) {
      withBytes(M, textEncoder.encode(key), (p, n) => check(M._bjw_put_key(p, n)));
      writeValue(M, val[key]);
    }
    check(M._bjw_end_object());
    return;
  }
  throw new Error(`Unsupported type: ${t}`);
}

/**
 * Encode a JavaScript value to binjson binary format.
 * @returns {Uint8Array}
 */
function encode(value) {
  const M = requireModule();
  check(M._bjw_enc_reset());
  writeValue(M, value);
  const len = M._bjw_enc_finish();
  if (len < 0) throw codeError(len, 'encode');
  const ptr = M._bjw_enc_ptr();
  // Copy out: the builder buffer is reused on the next encode call.
  return M.HEAPU8.slice(ptr, ptr + len);
}

/** Rebuild a JS value from the flat event stream emitted by the C decoder. */
function readEvents(M, ptr, len) {
  const heap = M.HEAPU8;
  const dv = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
  const stack = [];
  let root;
  let off = ptr;
  const end = ptr + len;

  const emit = (v) => {
    if (stack.length === 0) { root = v; return; }
    const top = stack[stack.length - 1];
    if (top.isObject) { top.value[top.key] = v; top.key = undefined; }
    else top.value.push(v);
  };

  while (off < end) {
    const tag = heap[off++];
    switch (tag) {
      case EV.NULL: emit(null); break;
      case EV.FALSE: emit(false); break;
      case EV.TRUE: emit(true); break;
      case EV.INT: emit(dv.getFloat64(off, true)); off += 8; break;
      case EV.FLOAT: emit(dv.getFloat64(off, true)); off += 8; break;
      case EV.DATE: emit(new Date(dv.getFloat64(off, true))); off += 8; break;
      case EV.POINTER: emit(new Pointer(dv.getFloat64(off, true))); off += 8; break;
      case EV.STRING: {
        const n = dv.getUint32(off, true); off += 4;
        emit(textDecoder.decode(heap.subarray(off, off + n))); off += n;
        break;
      }
      case EV.KEY: {
        const n = dv.getUint32(off, true); off += 4;
        stack[stack.length - 1].key = textDecoder.decode(heap.subarray(off, off + n));
        off += n;
        break;
      }
      case EV.BINARY: {
        const n = dv.getUint32(off, true); off += 4;
        emit(heap.slice(off, off + n)); off += n;
        break;
      }
      case EV.OID: {
        emit(new ObjectId(heap.slice(off, off + 12))); off += 12;
        break;
      }
      case EV.ARR_BEGIN: off += 4; stack.push({ isObject: false, value: [] }); break;
      case EV.OBJ_BEGIN: off += 4; stack.push({ isObject: true, value: {}, key: undefined }); break;
      case EV.ARR_END:
      case EV.OBJ_END: emit(stack.pop().value); break;
      default: throw new Error(`binjson: bad event tag ${tag}`);
    }
  }
  return root;
}

/**
 * Decode binjson binary data to a JavaScript value.
 * @param {Uint8Array|ArrayBuffer} data
 */
function decode(data) {
  const M = requireModule();
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const n = u8.length;
  const inPtr = n ? M._malloc(n) : 0;
  if (n) M.HEAPU8.set(u8, inPtr);

  let rc;
  try {
    rc = M._bjw_decode(inPtr, n);
  } finally {
    if (n) M._free(inPtr);
  }
  if (rc !== 0) throw codeError(rc, 'decode');

  const evPtr = M._bjw_events_ptr();
  const evLen = M._bjw_events_len();
  return readEvents(M, evPtr, evLen);
}

/**
 * Total on-wire size of the value whose leading bytes are `header`, computed by
 * the C codec (bj_value_size). `header` only needs the type byte plus, for
 * length-prefixed/container types, the 4-byte size field (i.e. up to 5 bytes).
 */
function wasmValueSize(M, header) {
  const n = header.length;
  const inPtr = M._malloc(n + 4);
  M.HEAPU8.set(header, inPtr);
  const outPtr = inPtr + n;
  const rc = M._bjw_value_size(inPtr, n, 0, outPtr);
  let size = 0;
  if (rc === 0) {
    size = new DataView(M.HEAPU8.buffer).getUint32(outPtr, true);
  }
  M._free(inPtr);
  if (rc !== 0) throw codeError(rc, 'value_size');
  return size;
}

/**
 * On-wire size (in bytes) of the top-level value whose leading bytes are
 * `header`, computed by the C codec. `header` only needs the type byte plus,
 * for length-prefixed/container types, the 4-byte size field (i.e. up to 5
 * bytes). Await ready() before calling. Useful for scanning append-only files
 * of concatenated records without decoding each one.
 */
function valueSize(header) {
  const M = requireModule();
  return wasmValueSize(M, header instanceof Uint8Array ? header : new Uint8Array(header));
}

/**
 * OPFS-backed file using a FileSystemSyncAccessHandle, with the binjson codec
 * running in WASM. Byte-level work (encode/decode + scan record sizing) is done
 * in C; only the raw synchronous handle calls (read/write/truncate/getSize/
 * flush) — which are browser APIs with no WASM equivalent — stay in JS.
 *
 * As with the reference, this requires FileSystemSyncAccessHandle (Web Workers)
 * and the WASM module to be initialized (await ready() first).
 */
class BinJsonFile {
  constructor(syncAccessHandle) {
    if (!syncAccessHandle) {
      throw new Error('FileSystemSyncAccessHandle is required');
    }
    this.syncAccessHandle = syncAccessHandle;
  }

  /** Read a range of bytes, returning only what was actually read. */
  #readRange(start, length) {
    const buffer = new Uint8Array(length);
    const bytesRead = this.syncAccessHandle.read(buffer, { at: start });
    return bytesRead < length ? buffer.slice(0, bytesRead) : buffer;
  }

  getFileSize() {
    return this.syncAccessHandle.getSize();
  }

  /** Encode and write `data`, replacing any existing content. */
  write(data) {
    const binaryData = encode(data);
    this.syncAccessHandle.truncate(0);
    this.syncAccessHandle.write(binaryData, { at: 0 });
  }

  /** Read and decode the value at `pointer` (default: start of file). */
  read(pointer = new Pointer(0)) {
    const fileSize = this.getFileSize();
    if (fileSize === 0) {
      throw new Error('File is empty');
    }
    const pointerValue = pointer.valueOf();
    if (pointerValue < 0 || pointerValue >= fileSize) {
      throw new Error(`Pointer offset ${pointer} out of file bounds [0, ${fileSize})`);
    }
    const binaryData = this.#readRange(pointerValue, fileSize - pointerValue);
    return decode(binaryData);
  }

  /** Encode and append `data` without truncating existing content. */
  append(data) {
    const binaryData = encode(data);
    const existingSize = this.getFileSize();
    this.syncAccessHandle.write(binaryData, { at: existingSize });
  }

  flush() {
    this.syncAccessHandle.flush();
  }

  /**
   * Yield each top-level record in the file, decoded one at a time as
   * `{ value, offset, size }`, where `offset` is the record's byte position in
   * the file and `size` is the number of bytes it occupies.
   */
  *scan() {
    const fileSize = this.getFileSize();
    if (fileSize === 0) return;

    const M = requireModule();
    let offset = 0;
    while (offset < fileSize) {
      // The value-size header needs at most type byte + 4-byte length field.
      const headerLen = Math.min(5, fileSize - offset);
      const header = this.#readRange(offset, headerLen);
      const valueSize = wasmValueSize(M, header);

      const valueData = this.#readRange(offset, valueSize);
      const valueOffset = offset;
      offset += valueSize;
      yield { value: decode(valueData), offset: valueOffset, size: valueSize };
    }
  }
}

export {
  ready,
  isReady,
  TYPE,
  ObjectId,
  Pointer,
  encode,
  decode,
  valueSize,
  BinJsonFile,
  MemoryHandle,
  exists,
  deleteFile,
  getFileHandle
};
