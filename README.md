# binjson

A compact binary encoding for JSON-like values (null/bool/int/float/string/
binary/array/object, plus MongoDB-style `ObjectId` and a byte-`Pointer`
extension), with OPFS-friendly file support (`BinJsonFile`: encode-and-write,
read-and-decode, append, and record-at-a-time `scan()` over an append-only
file).

Split out from the parent `binjson` document-database project (currently
staged here ahead of becoming its own git submodule/repo — see the parent
project's `third_party/regex-engine` for the pattern this is following).

## Layout

- `include/binjson.h`, `src/binjson.c` — the C codec. No dependencies beyond
  the C standard library.
- `src/binjson_wasm.c` — a thin Emscripten export shim over `binjson.c`
  (the `_bjw_*` functions).
- `js/binjson.js` — a pure-JS implementation of the same codec. No
  dependencies, no build step; works anywhere (Node, browser, wherever).
- `wasm/binjson-wasm.js` + `build-wasm.sh` — the WASM-backed implementation:
  build with `./build-wasm.sh` (requires `emcc`/emsdk on `PATH`) to produce
  `lib/binjson.wasm(.mjs)`, then `import` from `wasm/binjson-wasm.js`.

The pure-JS and WASM implementations are wire-compatible: bytes either one
writes are read correctly by the other.

## Usage

```js
// Pure JS, no build step:
import { encode, decode, ObjectId, Pointer } from './js/binjson.js';

// Or WASM-backed (build first):
import { ready, encode, decode, ObjectId, Pointer } from './wasm/binjson-wasm.js';
await ready();

const bytes = encode({ _id: new ObjectId(), name: 'Ada', joined: new Date() });
const doc = decode(bytes);
```

Both implementations export the same surface: `TYPE`, `ObjectId`, `Pointer`,
`encode`, `decode`, `BinJsonFile`, `MemoryHandle`, `exists`, `deleteFile`,
`getFileHandle` (the WASM build adds `ready`/`isReady`/`valueSize`).
