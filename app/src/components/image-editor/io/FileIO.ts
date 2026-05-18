import { PhobosDocument }   from '../editor/PhobosDocument';
import { PhobosLayer }      from '../editor/PhobosLayer';

// =============================================================================
// FileIO
//
// All file operations for Phobos Image Editor.
//
// Open:
//   - PNG, JPEG, WebP, BMP, GIF — via createImageBitmap (browser-native)
//   - .phi (native format) — JSON + base64 layer data, gzip compressed
//
// Export:
//   - PNG, JPEG, WebP — canvas.convertToBlob()
//   - .phi — JSON envelope + base64 RGBA per layer, gzip via CompressionStream
//
// The flatten canvas on PhobosDocument is reused for export — no new
// allocation per export call.
//
// IndexedDB persistence is handled separately (auto-save). This file
// is pure open/save logic only.
// =============================================================================

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/**
 * Open a file from a File object and return a new PhobosDocument.
 * Supports PNG, JPEG, WebP, BMP, GIF, and .phi.
 */
export async function openFile(
  file:     File,
  dpr:      number,
  options?: { historyLimit?: number },
): Promise<PhobosDocument> {
  if (file.name.endsWith('.phi')) {
    return openPhi(file, dpr, options);
  }
  return openRaster(file, dpr, options);
}

async function openRaster(
  file:     File,
  dpr:      number,
  options?: { historyLimit?: number },
): Promise<PhobosDocument> {
  const bitmap = await createImageBitmap(file);
  const doc    = new PhobosDocument(bitmap.width, bitmap.height, dpr, {
    historyLimit:    options?.historyLimit,
    backgroundImage: bitmap,
  });
  bitmap.close();
  doc.dirty = false;
  return doc;
}

async function openPhi(
  file:     File,
  dpr:      number,
  options?: { historyLimit?: number },
): Promise<PhobosDocument> {
  // Decompress gzip.
  const compressed   = await file.arrayBuffer();
  const decompressed = await decompress(compressed);
  const text         = new TextDecoder().decode(decompressed);
  const envelope     = JSON.parse(text) as PhiEnvelope;

  if (envelope.version !== 1) {
    throw new Error(`Unsupported .phi version: ${envelope.version}`);
  }

  // Create a blank document at the saved dimensions.
  const doc = new PhobosDocument(envelope.width, envelope.height, envelope.dpr ?? dpr, {
    historyLimit: options?.historyLimit,
  });

  // Remove the auto-created background layer — we'll restore saved layers.
  // PhobosDocument always creates one layer in the constructor; remove it.
  const initialLayerId = doc.layers[0].id;
  // We can't remove the last layer, so we replace it after adding others.

  const layersToAdd = envelope.layers;
  if (layersToAdd.length === 0) throw new Error('.phi file has no layers');

  // Restore first layer into the existing background slot.
  await restoreLayer(doc.layers[0], layersToAdd[0], doc.physicalWidth, doc.physicalHeight);
  doc.layers[0].name      = layersToAdd[0].name;
  doc.layers[0].opacity   = layersToAdd[0].opacity;
  doc.layers[0].blendMode = layersToAdd[0].blendMode as any;
  doc.layers[0].visible   = layersToAdd[0].visible;
  doc.layers[0].locked    = layersToAdd[0].locked;

  // Add remaining layers.
  for (let i = 1; i < layersToAdd.length; i++) {
    const saved = layersToAdd[i];
    const layer = doc.addLayer({
      name:      saved.name,
      opacity:   saved.opacity,
      blendMode: saved.blendMode as any,
      visible:   saved.visible,
      locked:    saved.locked,
    });
    await restoreLayer(layer, saved, doc.physicalWidth, doc.physicalHeight);
  }

  doc.setActiveLayer(Math.min(envelope.activeLayerIndex ?? 0, doc.layers.length - 1));
  doc.dirty = false;
  void initialLayerId;
  return doc;
}

async function restoreLayer(
  layer:  PhobosLayer,
  saved:  PhiLayer,
  physW:  number,
  physH:  number,
): Promise<void> {
  const bytes   = base64ToBytes(saved.data);
  const imgData = new ImageData(new Uint8ClampedArray(bytes.buffer as ArrayBuffer), physW, physH);
  layer.ctx.putImageData(imgData, 0, 0);
}

// ---------------------------------------------------------------------------
// Export raster
// ---------------------------------------------------------------------------

export async function exportPNG(doc: PhobosDocument): Promise<Blob> {
  return exportRaster(doc, 'image/png');
}

export async function exportJPEG(doc: PhobosDocument, quality = 0.92): Promise<Blob> {
  return exportRaster(doc, 'image/jpeg', quality);
}

export async function exportWebP(doc: PhobosDocument, quality = 0.92): Promise<Blob> {
  return exportRaster(doc, 'image/webp', quality);
}

async function exportRaster(
  doc:     PhobosDocument,
  type:    string,
  quality?: number,
): Promise<Blob> {
  const canvas = doc.flatten();
  const blob   = await canvas.convertToBlob({ type, quality });
  if (!blob) throw new Error(`Failed to encode ${type}`);
  return blob;
}

// ---------------------------------------------------------------------------
// Export .phi
// ---------------------------------------------------------------------------

export async function exportPhi(doc: PhobosDocument): Promise<Blob> {
  const layers: PhiLayer[] = await Promise.all(
    doc.layers.map(async layer => ({
      name:      layer.name,
      opacity:   layer.opacity,
      blendMode: layer.blendMode,
      visible:   layer.visible,
      locked:    layer.locked,
      data:      layerToBase64(layer, doc.physicalWidth, doc.physicalHeight),
    })),
  );

  const envelope: PhiEnvelope = {
    version:          1,
    width:            doc.cssWidth,
    height:           doc.cssHeight,
    dpr:              doc.dpr,
    activeLayerIndex: doc.activeLayerIndex,
    layers,
  };

  const json      = JSON.stringify(envelope);
  const bytes     = new TextEncoder().encode(json);
  const compressed = await compress(bytes);
  return new Blob([compressed], { type: 'application/octet-stream' });
}

// ---------------------------------------------------------------------------
// Download helpers (browser)
// ---------------------------------------------------------------------------

/**
 * Trigger a browser download of a Blob.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href    = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Open the browser's file picker and return the selected File.
 * Accepts: PNG, JPEG, WebP, BMP, GIF, .phi
 */
export function pickOpenFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input    = document.createElement('input');
    input.type     = 'file';
    input.accept   = '.png,.jpg,.jpeg,.webp,.bmp,.gif,.phi,image/*';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// ---------------------------------------------------------------------------
// IndexedDB auto-save
// ---------------------------------------------------------------------------

const IDB_NAME    = 'phobos-image-editor';
const IDB_VERSION = 1;
const IDB_STORE   = 'sessions';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Persist the current document to IndexedDB as a .phi payload.
 * Called on every command push (debounced by the caller).
 */
export async function autoSave(doc: PhobosDocument, key = 'autosave'): Promise<void> {
  const blob  = await exportPhi(doc);
  const buf   = await blob.arrayBuffer();
  const db    = await openDB();
  const tx    = db.transaction(IDB_STORE, 'readwrite');
  tx.objectStore(IDB_STORE).put(buf, key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
  db.close();
}

/**
 * Restore the last auto-saved document from IndexedDB.
 * Returns null if no saved session exists.
 */
export async function restoreAutoSave(
  dpr:     number,
  key  = 'autosave',
  options?: { historyLimit?: number },
): Promise<PhobosDocument | null> {
  try {
    const db  = await openDB();
    const tx  = db.transaction(IDB_STORE, 'readonly');
    const buf = await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
      const req   = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
      req.onerror   = () => reject(req.error);
    });
    db.close();
    if (!buf) return null;
    const file = new File([buf], 'autosave.phi');
    return openPhi(file, dpr, options);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// .phi envelope types
// ---------------------------------------------------------------------------

interface PhiLayer {
  name:      string;
  opacity:   number;
  blendMode: string;
  visible:   boolean;
  locked:    boolean;
  /** base64-encoded RGBA Uint8ClampedArray at physical dimensions */
  data:      string;
}

interface PhiEnvelope {
  version:           1;
  width:             number;
  height:            number;
  dpr:               number;
  activeLayerIndex:  number;
  layers:            PhiLayer[];
}

// ---------------------------------------------------------------------------
// Helpers — base64, compression
// ---------------------------------------------------------------------------

function layerToBase64(layer: PhobosLayer, physW: number, physH: number): string {
  const imgData = layer.ctx.getImageData(0, 0, physW, physH);
  const bytes   = new Uint8Array(imgData.data.buffer);
  let   binary  = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function compress(data: Uint8Array): Promise<ArrayBuffer> {
  const stream      = new CompressionStream('gzip');
  const writer      = stream.writable.getWriter();
  const reader      = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  writer.write(data.buffer as ArrayBuffer);
  writer.close();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total  = chunks.reduce((n, c) => n + c.length, 0);
  const result = new Uint8Array(total);
  let   offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result.buffer;
}

async function decompress(data: ArrayBuffer): Promise<Uint8Array> {
  const stream      = new DecompressionStream('gzip');
  const writer      = stream.writable.getWriter();
  const reader      = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  writer.write(new Uint8Array(data));
  writer.close();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total  = chunks.reduce((n, c) => n + c.length, 0);
  const result = new Uint8Array(total);
  let   offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
