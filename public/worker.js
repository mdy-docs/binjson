// Web Worker for handling OPFS file operations with sync access handles
// This worker handles file operations that require FileSystemSyncAccessHandle

// The codec is backed by the combined WASM module, loaded once via
// ../wasm/binjson-wasm.js (which pulls in ../lib/binjson.wasm.mjs). The
// on-disk format is identical to the pure-JS reference, so files written
// either way remain interoperable.
import {
  ready,
  decode,
  valueSize,
  getFileHandle
} from '../wasm/binjson-wasm.js';

// Resolve the OPFS root, with a clear error when it isn't available. OPFS is
// only exposed in a secure context (https or http://localhost) and in browsers
// that support it (Chrome/Edge/Opera 102+, Safari 16.4+).
async function getRootDir() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) {
    throw new Error(
      'OPFS is not available in this context. Serve over https or http://localhost ' +
      'and use Chrome/Edge/Opera 102+ or Safari 16.4+.'
    );
  }
  return navigator.storage.getDirectory();
}

// Helper function to read all data from sync handle
function readAllData(syncHandle) {
  const size = syncHandle.getSize();
  if (size === 0) return new Uint8Array(0);

  const buffer = new Uint8Array(size);
  const view = new DataView(buffer.buffer);
  syncHandle.read(view, { at: 0 });
  return buffer;
}

// Handle messages from the main thread
self.addEventListener('message', async (event) => {
  const { id, operation, filename, data } = event.data;

  try {
    // Ensure the WASM module is instantiated before any decode/valueSize call.
    // Idempotent and cached, so this is cheap per message.
    await ready();

    let result;

    switch (operation) {
      case 'write': {
        const dirHandle = await getRootDir();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: true });
        const syncHandle = await fileHandle.createSyncAccessHandle();

        // Truncate and write
        syncHandle.truncate(0);
        const buffer = new Uint8Array(data);
        const view = new DataView(buffer.buffer);
        syncHandle.write(view, { at: 0 });

        const finalSize = syncHandle.getSize();
        await syncHandle.close();
        result = { success: true, size: finalSize };
        break;
      }

      case 'read': {
        const dirHandle = await getRootDir();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: false });
        const syncHandle = await fileHandle.createSyncAccessHandle();

        const buffer = readAllData(syncHandle);
        const decoded = buffer.length > 0 ? decode(buffer) : null;

        await syncHandle.close();
        result = decoded;
        break;
      }

      // Return the raw file bytes so the main thread can decode with a chosen
      // codec (JS or WASM) and preserve rich types (ObjectId/Pointer/etc.).
      case 'read-bytes': {
        const dirHandle = await getRootDir();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: false });
        const syncHandle = await fileHandle.createSyncAccessHandle();

        const buffer = readAllData(syncHandle);
        await syncHandle.close();
        result = Array.from(buffer);
        break;
      }

      case 'append': {
        const dirHandle = await getRootDir();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: true });
        const syncHandle = await fileHandle.createSyncAccessHandle();

        const currentSize = syncHandle.getSize();
        const buffer = new Uint8Array(data);
        const view = new DataView(buffer.buffer);
        syncHandle.write(view, { at: currentSize });

        const finalSize = syncHandle.getSize();
        await syncHandle.close();
        result = { success: true, size: finalSize };
        break;
      }

      case 'scan': {
        const dirHandle = await getRootDir();
        const fileHandle = await getFileHandle(dirHandle, filename, { create: false });
        const syncHandle = await fileHandle.createSyncAccessHandle();

        const buffer = readAllData(syncHandle);
        const records = [];

        // Walk the concatenated records using the WASM codec's exact on-wire
        // size for each value (the header needs at most the type byte plus a
        // 4-byte length field), rather than re-encoding to guess the length.
        let offset = 0;
        while (offset < buffer.length) {
          try {
            const header = buffer.subarray(offset, offset + Math.min(5, buffer.length - offset));
            const size = valueSize(header);
            records.push(decode(buffer.subarray(offset, offset + size)));
            offset += size;
          } catch (err) {
            break; // End of valid data
          }
        }

        await syncHandle.close();
        result = records;
        break;
      }

      case 'delete': {
        const dirHandle = await getRootDir();
        try {
          await dirHandle.removeEntry(filename);
        } catch (err) {
          if (err.name !== 'NotFoundError') {
            throw err;
          }
        }
        result = { success: true };
        break;
      }

      case 'exists': {
        const dirHandle = await getRootDir();
        let exists = false;
        try {
          // Explicitly use create: false to avoid creating the file
          await dirHandle.getFileHandle(filename, { create: false });
          exists = true;
        } catch (err) {
          // Any error means file doesn't exist
          exists = false;
        }
        result = exists;
        break;
      }

      default:
        throw new Error(`Unknown operation: ${operation}`);
    }

    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
});
