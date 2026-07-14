#!/usr/bin/env bash
# Build the standalone binjson-only WASM module: lib/binjson.wasm +
# lib/binjson.wasm.mjs (the ES module loader), loaded by wasm/binjson-wasm.js.
# Mirrors the parent project's c/build-wasm.sh (same flags, same
# build_module shape) but links only this package's two C sources --
# nothing here depends on the parent repo. Requires `emcc` on PATH (emsdk).
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p lib

# Same flags as the parent project's combined build (c/build-wasm.sh) --
# see its own comment for why the stack size/overflow-check flags matter;
# irrelevant to a codec with no recursive tree traversal, but harmless to
# keep, and this stays a straightforward diff against that script rather
# than a divergent one.
COMMON_FLAGS=(
  -O3
  -flto
  -Iinclude
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sALLOW_MEMORY_GROWTH=1
  -sSTACK_SIZE=1048576
  -sSTACK_OVERFLOW_CHECK=1
  -sENVIRONMENT=web,worker,node
  -sEXPORTED_RUNTIME_METHODS=HEAPU8
  -sALLOW_TABLE_GROWTH=0
  -sFILESYSTEM=0
  --no-entry
)

EXPORTS='_malloc,_free,'\
'_bjw_enc_reset,_bjw_put_null,_bjw_put_bool,_bjw_put_int,_bjw_put_float,'\
'_bjw_put_date,_bjw_put_pointer,_bjw_put_string,_bjw_put_binary,_bjw_put_oid,'\
'_bjw_put_key,_bjw_begin_array,_bjw_end_array,_bjw_begin_object,_bjw_end_object,'\
'_bjw_enc_finish,_bjw_enc_ptr,_bjw_enc_size,'\
'_bjw_decode,_bjw_events_ptr,_bjw_events_len,_bjw_consumed,_bjw_value_size'

emcc src/binjson.c src/binjson_wasm.c \
  "${COMMON_FLAGS[@]}" \
  -sEXPORT_NAME=createBinjsonModule \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -o lib/binjson.mjs

mv lib/binjson.mjs lib/binjson.wasm.mjs
echo "built lib/binjson.wasm.mjs ($(wc -c < lib/binjson.wasm) bytes wasm)"
