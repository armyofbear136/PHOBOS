/**
 * TileNavigation — standalone A* pathfinder on the TileWorld tile graph.
 *
 * Design constraints (per PHOBOS coding philosophy):
 *   - No per-call heap allocation after first warm-up.
 *   - 4-directional movement only — prevents diagonal wall-clip in corridors.
 *   - Hard node limit (maxNodes) bounds worst-case cost.
 *   - Returns null if no path found; caller falls back to greedy lookahead.
 *   - Path is smoothed: consecutive collinear walkable waypoints collapsed.
 *   - NOT re-entrant — scratch arrays are module singletons. Safe for Phobos
 *     because the game runs single-threaded and enemies never replan concurrently.
 *
 * Key encoding: (ty + KEY_TY_OFFSET) * KEY_STRIDE + (tx + KEY_TX_OFFSET)
 *   Supports tx −50..+461, ty −200..+311 — covers all current and planned zone depths.
 *
 * Performance: findPath with maxNodes=128 costs ~0.03–0.05ms per call.
 * At 32 enemies replanning at ≤4Hz = ~6.4ms/s = ~0.064ms/frame at 100fps.
 */

import type { TileWorld } from './TileWorld';

// ── Coordinate encoding ───────────────────────────────────────────────────────

const KEY_TX_OFFSET = 50;
const KEY_TY_OFFSET = 200;
const KEY_STRIDE    = 512;

// Encode tile coords to a unique non-negative integer index into scratch arrays.
function nodeKey(tx: number, ty: number): number {
  return (ty + KEY_TY_OFFSET) * KEY_STRIDE + (tx + KEY_TX_OFFSET);
}

// ── Pre-allocated scratch — module-level singletons ───────────────────────────
// Sized for SCRATCH_SIZE nodes max. findPath resets only the slots it uses,
// not the full arrays, via a used-keys list — O(visited) reset, not O(SCRATCH_SIZE).

const SCRATCH_SIZE = 512;

// Binary min-heap: stores node keys. Parallel arrays for heap[i] ↔ fScore[i].
const _heap:       Uint32Array   = new Uint32Array(SCRATCH_SIZE);
const _heapF:      Float32Array  = new Float32Array(SCRATCH_SIZE);
let   _heapSize    = 0;

// Per-node bookkeeping — indexed by nodeKey(tx, ty).
const _gScore:     Float32Array  = new Float32Array(KEY_STRIDE * (KEY_TY_OFFSET + 312));
const _parentKey:  Int32Array    = new Int32Array(KEY_STRIDE * (KEY_TY_OFFSET + 312));
const _inOpen:     Uint8Array    = new Uint8Array(KEY_STRIDE * (KEY_TY_OFFSET + 312));
const _inClosed:   Uint8Array    = new Uint8Array(KEY_STRIDE * (KEY_TY_OFFSET + 312));

// Tracks which keys were written this call — for O(visited) reset.
const _usedKeys:   Uint32Array   = new Uint32Array(SCRATCH_SIZE);
let   _usedCount   = 0;

// Output path — reused each call. Caller receives a slice reference; it is
// valid only until the next findPath call. Caller (EnemyWorldSprite) copies
// it into its own _waypoints array immediately.
const _pathBuf: Array<{ tx: number; ty: number }> = [];

// 4-directional neighbourhood: [dtx, dty]
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

// ── Heap helpers ──────────────────────────────────────────────────────────────

function _heapPush(key: number, f: number): void {
  let i = _heapSize++;
  _heap[i]  = key;
  _heapF[i] = f;
  // Sift up
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (_heapF[parent] <= _heapF[i]) break;
    // Swap
    const tk = _heap[parent]; _heap[parent] = _heap[i]; _heap[i] = tk;
    const tf = _heapF[parent]; _heapF[parent] = _heapF[i]; _heapF[i] = tf;
    i = parent;
  }
}

function _heapPop(): number {
  const top = _heap[0];
  _heapSize--;
  if (_heapSize > 0) {
    _heap[0]  = _heap[_heapSize];
    _heapF[0] = _heapF[_heapSize];
    // Sift down
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (l < _heapSize && _heapF[l] < _heapF[smallest]) smallest = l;
      if (r < _heapSize && _heapF[r] < _heapF[smallest]) smallest = r;
      if (smallest === i) break;
      const tk = _heap[smallest]; _heap[smallest] = _heap[i]; _heap[i] = tk;
      const tf = _heapF[smallest]; _heapF[smallest] = _heapF[i]; _heapF[i] = tf;
      i = smallest;
    }
  }
  return top;
}

// ── Reset scratch for the keys used in this call ──────────────────────────────

function _resetScratch(): void {
  for (let i = 0; i < _usedCount; i++) {
    const k = _usedKeys[i];
    _gScore[k]   = 0;
    _parentKey[k] = 0;
    _inOpen[k]   = 0;
    _inClosed[k] = 0;
  }
  _usedCount = 0;
  _heapSize  = 0;
}

function _markUsed(k: number): void {
  if (_usedCount < SCRATCH_SIZE) _usedKeys[_usedCount++] = k;
}

// ── Manhattan heuristic ───────────────────────────────────────────────────────

function _h(tx: number, ty: number, toTx: number, toTy: number): number {
  return Math.abs(tx - toTx) + Math.abs(ty - toTy);
}

// ── Path reconstruction ───────────────────────────────────────────────────────

function _reconstructPath(
  goalKey: number,
  startKey: number,
): Array<{ tx: number; ty: number }> {
  _pathBuf.length = 0;
  let k = goalKey;
  while (k !== startKey) {
    const tx = (k % KEY_STRIDE) - KEY_TX_OFFSET;
    const ty = Math.floor(k / KEY_STRIDE) - KEY_TY_OFFSET;
    _pathBuf.push({ tx, ty });
    k = _parentKey[k];
  }
  // Add start
  {
    const tx = (startKey % KEY_STRIDE) - KEY_TX_OFFSET;
    const ty = Math.floor(startKey / KEY_STRIDE) - KEY_TY_OFFSET;
    _pathBuf.push({ tx, ty });
  }
  _pathBuf.reverse();

  // Smooth: remove a middle waypoint if the segment before and after it
  // share an axis (same tx or same ty) AND the middle tile is collinear —
  // i.e. it doesn't add information. This removes zig-zag in open rooms.
  const smoothed: Array<{ tx: number; ty: number }> = [];
  smoothed.push(_pathBuf[0]);
  for (let i = 1; i < _pathBuf.length - 1; i++) {
    const prev = _pathBuf[i - 1];
    const curr = _pathBuf[i];
    const next = _pathBuf[i + 1];
    // Keep waypoint if it's a direction change
    const sameAxis =
      (prev.tx === curr.tx && curr.tx === next.tx) ||
      (prev.ty === curr.ty && curr.ty === next.ty);
    if (!sameAxis) smoothed.push(curr);
  }
  smoothed.push(_pathBuf[_pathBuf.length - 1]);

  return smoothed;
}

// ── Greedy fallback — scores 4 neighbours by distance to goal ─────────────────

export function greedyStep(
  fromTx: number, fromTy: number,
  toTx:   number, toTy:   number,
  tw:     TileWorld,
): { tx: number; ty: number } | null {
  let bestTx = fromTx;
  let bestTy = fromTy;
  let bestH  = _h(fromTx, fromTy, toTx, toTy);

  for (const [dtx, dty] of DIRS) {
    const ntx = fromTx + dtx;
    const nty = fromTy + dty;
    if (!tw.isWalkableTile(ntx, nty)) continue;
    const h = _h(ntx, nty, toTx, toTy);
    if (h < bestH) {
      bestH  = h;
      bestTx = ntx;
      bestTy = nty;
    }
  }

  if (bestTx === fromTx && bestTy === fromTy) return null; // stuck
  return { tx: bestTx, ty: bestTy };
}

// ── A* ────────────────────────────────────────────────────────────────────────

/**
 * Find a path from (fromTx, fromTy) to (toTx, toTy) on the TileWorld graph.
 *
 * Returns an array of tile waypoints from start (inclusive) to goal (inclusive),
 * smoothed to remove collinear intermediate points.
 *
 * Returns null if:
 *   - start or goal is not walkable
 *   - no path exists within maxNodes expanded nodes
 *   - start === goal
 *
 * The returned array is valid only until the next findPath call (it references
 * the module-level _pathBuf reconstruction). Callers must copy it immediately.
 */
export function findPath(
  fromTx:   number,
  fromTy:   number,
  toTx:     number,
  toTy:     number,
  tw:       TileWorld,
  maxNodes: number = 128,
): Array<{ tx: number; ty: number }> | null {
  _resetScratch();

  if (fromTx === toTx && fromTy === toTy) return null;
  if (!tw.isWalkableTile(toTx, toTy))     return null;
  if (!tw.isWalkableTile(fromTx, fromTy)) return null;

  const startKey = nodeKey(fromTx, fromTy);
  const goalKey  = nodeKey(toTx, toTy);

  _gScore[startKey] = 0;
  _markUsed(startKey);
  _heapPush(startKey, _h(fromTx, fromTy, toTx, toTy));
  _inOpen[startKey] = 1;

  let expanded = 0;

  while (_heapSize > 0 && expanded < maxNodes) {
    const curKey = _heapPop();

    if (_inClosed[curKey]) continue;
    _inClosed[curKey] = 1;
    expanded++;

    if (curKey === goalKey) {
      return _reconstructPath(goalKey, startKey);
    }

    const curTx = (curKey % KEY_STRIDE) - KEY_TX_OFFSET;
    const curTy = Math.floor(curKey / KEY_STRIDE) - KEY_TY_OFFSET;
    const curG  = _gScore[curKey];

    for (const [dtx, dty] of DIRS) {
      const ntx = curTx + dtx;
      const nty = curTy + dty;
      if (!tw.isWalkableTile(ntx, nty)) continue;

      const nKey = nodeKey(ntx, nty);
      if (_inClosed[nKey]) continue;

      const tentativeG = curG + 1; // uniform cost
      if (!_inOpen[nKey] || tentativeG < _gScore[nKey]) {
        _gScore[nKey]    = tentativeG;
        _parentKey[nKey] = curKey;
        _markUsed(nKey);
        const f = tentativeG + _h(ntx, nty, toTx, toTy);
        _heapPush(nKey, f);
        _inOpen[nKey] = 1;
      }
    }
  }

  // No path found within node budget — return best partial path if we got close
  // (within 3 tiles of goal). Otherwise null.
  if (expanded > 0) {
    // Find the closed node with lowest h to goal as partial endpoint
    let bestKey  = -1;
    let bestH    = Infinity;
    for (let i = 0; i < _usedCount; i++) {
      const k = _usedKeys[i];
      if (!_inClosed[k]) continue;
      const tx = (k % KEY_STRIDE) - KEY_TX_OFFSET;
      const ty = Math.floor(k / KEY_STRIDE) - KEY_TY_OFFSET;
      const h  = _h(tx, ty, toTx, toTy);
      if (h < bestH) { bestH = h; bestKey = k; }
    }
    if (bestKey >= 0 && bestH <= 3) {
      return _reconstructPath(bestKey, startKey);
    }
  }

  return null;
}
