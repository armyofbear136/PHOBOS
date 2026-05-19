/**
 * TileWorld — singleton spatial authority for the isometric world.
 *
 * Owns all tileToWorld / worldToTile math. Nothing else should contain
 * projection constants or derive bounds independently.
 *
 * Usage:
 *   1. TileWorld.init(halfTileW, halfTileH, originX) at scene start.
 *   2. Call registerTile(tx, ty) for every tile placed during map generation.
 *   3. Call seal() once after the loop — freezes camera + walk bounds.
 *   4. Query getCameraBounds() / getWalkBounds() / getCenter().
 *   5. For zone expansion: reset(), re-register all tiles, seal() again.
 */

export interface CameraBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WalkBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export class TileWorld {
  private static _instance: TileWorld | null = null;

  // Projection constants — set once via init()
  halfTileW: number;
  halfTileH: number;
  originX: number;
  mapW: number;
  mapH: number;

  // Running extents — expanded by registerTile()
  private _minX = Infinity;
  private _maxX = -Infinity;
  private _minY = Infinity;
  private _maxY = -Infinity;

  // Per-tile walkability — 1 = walkable, 0 = void. Flat row-major array.
  private _walkable: Uint8Array;

  // Blocked tiles — registered by placed buildings. Key: ty * mapW + tx.
  // Checked after _walkable so a building on a walkable tile blocks correctly.
  private _blocked = new Set<number>();

  // Frozen after seal()
  private _sealed = false;
  private _cameraBounds!: CameraBounds;
  private _walkBounds!: WalkBounds;
  private _centerX!: number;
  private _centerY!: number;

  private constructor(halfTileW: number, halfTileH: number, originX: number, mapW: number, mapH: number) {
    this.halfTileW = halfTileW;
    this.halfTileH = halfTileH;
    this.originX   = originX;
    this.mapW      = mapW;
    this.mapH      = mapH;
    this._walkable = new Uint8Array(mapW * mapH); // zeroed — void by default
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  static init(halfTileW: number, halfTileH: number, originX: number, mapW: number, mapH: number): TileWorld {
    TileWorld._instance = new TileWorld(halfTileW, halfTileH, originX, mapW, mapH);
    return TileWorld._instance;
  }

  /**
   * Reinitialise dimensions and clear walkability on the existing singleton.
   * Use this when returning to a scene that previously called init() — it avoids
   * creating a new instance (which would break any held references) while fully
   * resetting the tile data to the caller's coordinate space.
   */
  reinit(halfTileW: number, halfTileH: number, originX: number, mapW: number, mapH: number): void {
    this.halfTileW = halfTileW;
    this.halfTileH = halfTileH;
    this.originX   = originX;
    this.mapW      = mapW;
    this.mapH      = mapH;
    this._walkable  = new Uint8Array(mapW * mapH);
    this._blocked.clear();
    this._explorationTiles.clear();
    this._sealed    = false;
    this._minX      = Infinity;
    this._maxX      = -Infinity;
    this._minY      = Infinity;
    this._maxY      = -Infinity;
  }

  static getInstance(): TileWorld {
    if (!TileWorld._instance) {
      throw new Error('TileWorld.init() must be called before getInstance()');
    }
    return TileWorld._instance;
  }

  // ── Core math ──────────────────────────────────────────────────────────────

  tileToWorld(tx: number, ty: number): { x: number; y: number } {
    return {
      x: (tx - ty) * this.halfTileW + this.originX,
      y: (tx + ty) * this.halfTileH,
    };
  }

  worldToTile(wx: number, wy: number): { tx: number; ty: number } {
    const diff = (wx - this.originX) / this.halfTileW;  // tx - ty
    const sum  = wy / this.halfTileH;                    // tx + ty
    return {
      tx: Math.round((diff + sum) / 2),
      ty: Math.round((sum  - diff) / 2),
    };
  }

  // ── Registration ───────────────────────────────────────────────────────────

  /**
   * Register a walkable tile. Call for every non-void tile placed during map
   * generation. Expands the spatial extents and marks the tile walkable.
   */
  registerTile(tx: number, ty: number): void {
    const { x, y } = this.tileToWorld(tx, ty);
    if (x < this._minX) this._minX = x;
    if (x > this._maxX) this._maxX = x;
    if (y < this._minY) this._minY = y;
    if (y > this._maxY) this._maxY = y;
    this._walkable[ty * this.mapW + tx] = 1;
  }

  /**
   * Mark a tile as blocked by a placed building. Call for every tile in the
   * building's footprint after spawning the sprite. Safe to call post-seal.
   */
  registerBlocked(tx: number, ty: number): void {
    this._blocked.add(ty * this.mapW + tx);
  }

  /**
   * Remove a blocked tile — call when a building is dismantled or relocated.
   */
  unregisterBlocked(tx: number, ty: number): void {
    this._blocked.delete(ty * this.mapW + tx);
  }

  /** Returns all currently-blocked tiles as {tx,ty} pairs. Debug use only. */
  getBlockedTiles(): Array<{ tx: number; ty: number }> {
    const out: Array<{ tx: number; ty: number }> = [];
    for (const key of this._blocked) {
      // _blocked uses: key = ty * mapW + tx  (different from _exTileKey)
      // ty may be negative; Math.floor handles that correctly.
      const ty = Math.floor(key / this.mapW);
      const tx = key - ty * this.mapW;
      out.push({ tx, ty });
    }
    return out;
  }

  /** Zero-allocation check — true if tile (tx,ty) is in the blocked set. */
  isBlockedTile(tx: number, ty: number): boolean {
    return this._blocked.has(ty * this.mapW + tx);
  }

  /**
   * Returns true if the world position falls within a walkable tile.
   * Uses centre-point tile lookup — rounds to nearest tile.
   */
  isWalkable(wx: number, wy: number): boolean {
    const { tx, ty } = this.worldToTile(wx, wy);
    // Buildings always block, regardless of underlying tile walkability
    if (this._blocked.has(ty * this.mapW + tx)) return false;
    // Hub tiles — bounds-checked against walkable array
    if (tx >= 0 && tx < this.mapW && ty >= 0 && ty < this.mapH) {
      if (this._walkable[ty * this.mapW + tx] === 1) return true;
    }
    // Exploration tiles — no bounds restriction, ty may be negative
    return this._explorationTiles.has(this._exTileKey(tx, ty));
  }

  // ── Seal ───────────────────────────────────────────────────────────────────

  seal(): void {
    // padX/padY must be large enough that the camera can centre on any tile
    // at the world boundary without hitting the clamp. At zoom=2 the viewport
    // is ~canvas/2 world-pixels tall (~400px). A 320px pad covers all zoom
    // levels we support (1×–3×) without showing void at hub edges.
    const padX = 320;
    const padY = 320;

    this._cameraBounds = {
      x:      this._minX - padX,
      y:      this._minY - padY,
      width:  (this._maxX - this._minX) + padX * 2,
      height: (this._maxY - this._minY) + padY * 2,
    };

    // Inset the walk boundary by one half-tile so the sprite never sits on
    // the outermost diamond edge.
    this._walkBounds = {
      minX: this._minX + this.halfTileW,
      maxX: this._maxX - this.halfTileW,
      minY: this._minY + this.halfTileH,
      maxY: this._maxY - this.halfTileH,
    };

    this._centerX = (this._minX + this._maxX) / 2;
    this._centerY = (this._minY + this._maxY) / 2;
    this._sealed  = true;
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  getCameraBounds(): CameraBounds {
    this._assertSealed('getCameraBounds');
    return this._cameraBounds;
  }

  getWalkBounds(): WalkBounds {
    this._assertSealed('getWalkBounds');
    return this._walkBounds;
  }

  getCenter(): { x: number; y: number } {
    this._assertSealed('getCenter');
    return { x: this._centerX, y: this._centerY };
  }

  isSealed(): boolean {
    return this._sealed;
  }

  // ── Exploration tile registration (post-seal) ──────────────────────────────

  // Map keyed with offset so negative ty (zone extends north of hub) is safe.
  private _explorationTiles = new Map<number, boolean>();

  private _exTileKey(tx: number, ty: number): number {
    // Encoding: (ty + 700) * 2048 + (tx + 200)
    // Supports ty −700..+100, tx −200..+400 — covers 6 zones at 100 tiles deep each.
    // All values are unique non-negative integers well within JS safe-integer range.
    // Decode: ty = Math.floor(key / 2048) - 700,  tx = (key % 2048) - 200
    return (ty + 700) * 2048 + (tx + 200);
  }

  /**
   * Register a tile that belongs to the exploration zone.
   * Expands spatial extents so reseal() produces correct combined bounds.
   */
  registerExplorationTile(tx: number, ty: number): void {
    const { x, y } = this.tileToWorld(tx, ty);
    if (x < this._minX) this._minX = x;
    if (x > this._maxX) this._maxX = x;
    if (y < this._minY) this._minY = y;
    if (y > this._maxY) this._maxY = y;
    this._explorationTiles.set(this._exTileKey(tx, ty), true);
  }

  /**
   * Recompute camera and walk bounds to include exploration tiles.
   * Call once after all registerExplorationTile() calls complete.
   */
  reseal(): void {
    this.seal();
  }

  /** True if (tx, ty) has been registered as an exploration tile. */
  isExplorationTile(tx: number, ty: number): boolean {
    return this._explorationTiles.has(this._exTileKey(tx, ty));
  }

  // ── Reset (zone expansion) ─────────────────────────────────────────────────

  reset(): void {
    this._minX   = Infinity;
    this._maxX   = -Infinity;
    this._minY   = Infinity;
    this._maxY   = -Infinity;
    this._sealed = false;
    this._walkable.fill(0);
    this._blocked.clear();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _assertSealed(caller: string): void {
    if (!this._sealed) {
      throw new Error(`TileWorld.${caller}() called before seal()`);
    }
  }
}