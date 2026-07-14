/**
 * Runs the shared binjson conformance suite against the *standalone*
 * third_party/binjson build (its own minimal WASM module, built by
 * third_party/binjson/build-wasm.sh -- not the parent project's combined
 * lib/binjson.wasm) -- proof that the split-out package genuinely works
 * on its own, not just that its source compiles.
 */
import * as codec from '../wasm/binjson-wasm.js';
import { bootstrapOPFS, runCodecSuite, runFileSuite } from './binjson.suite.js';

await codec.ready();
const { hasOPFS } = await bootstrapOPFS();

runCodecSuite('Standalone WASM (third_party/binjson)', codec);
runFileSuite('Standalone WASM (third_party/binjson)', codec, hasOPFS);
