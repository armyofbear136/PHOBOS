/**
 * BuildingPlacementOverlay — React layer for building/machine placement.
 *
 * All coordinate math is delegated to WorldScene.screenToTile() and
 * WorldScene.tileToScreen() which use Phaser's camera.getWorldPoint()
 * internally. This is the only correct way to convert screen pixels to
 * world/tile coords — it handles zoom, scroll, and Scale Manager offsets.
 *
 * The ghost sprite is updated via direct DOM ref mutation on every mousemove
 * so there is zero React re-render lag.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MACHINE_BY_ID } from './HubBuildingCatalog';
import { WorldScene } from './WorldScene';
import { getTransform } from './CoordSystem';

// ── Types ──────────────────────────────────────────────────────────────────

export interface PlacementSession {
  buildingId: string;
  label:      string;
  existingId: string | null;
  onSuccess?: () => void;
}

interface GhostTile { tx: number; ty: number; valid: boolean; }

// ── Player zone bounds ─────────────────────────────────────────────────────
const PLAYER_ZONE = { x1: 24, y1: 16, x2: 38, y2: 27 } as const;

// ── Sprite URLs ────────────────────────────────────────────────────────────
const SPRITE_URL: Record<string, string> = {
  'building-fab':  'game/sprites/buildings/ProducerBulding_full.png',
  'machine-psi':   'game/sprites/machines/Comunication_machine.png',
  'machine-mpa':   'game/sprites/machines/Grab_machine.png',
  'machine-zpr':   'game/sprites/machines/Refill_machine.png',
  'machine-sfg':   'game/sprites/machines/Hammer_machine.png',
  'machine-fcs':   'game/sprites/machines/Cool_machine.png',
  'machine-spc':   'game/sprites/machines/Capacitor_machine.png',
  'machine-rcs':   'game/sprites/machines/Science_machine.png',
  'machine-tst-a': 'game/sprites/machines/Thruster_machine_A.png',
};
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
function spriteUrl(key: string): string {
  const path = SPRITE_URL[key];
  return path ? `${BASE}/${path}` : '';
}

// ── Static activation API ─────────────────────────────────────────────────
type BeginCallback = (session: PlacementSession) => void;
let _beginCb: BeginCallback | null = null;

export const BuildingPlacementOverlay = {
  begin(buildingId: string, label: string, onSuccess?: () => void): void {
    _beginCb?.({ buildingId, label, existingId: null, onSuccess });
  },
  relocate(buildingId: string, label: string, existingId: string, onSuccess?: () => void): void {
    _beginCb?.({ buildingId, label, existingId, onSuccess });
  },
};

// ── Props ──────────────────────────────────────────────────────────────────
interface Props {
  engineUrl:     string;
  occupiedTiles: Set<string>;
  onPlaced:    (buildingId: string, tileX: number, tileY: number) => void;
  onRelocated: (recordId: string,   tileX: number, tileY: number) => void;
}

// ── Component ──────────────────────────────────────────────────────────────
export function BuildingPlacementOverlayPanel({
  engineUrl, occupiedTiles, onPlaced, onRelocated,
}: Props): React.ReactElement | null {
  const [session,  setSession]  = useState<PlacementSession | null>(null);
  const [posting,  setPosting]  = useState(false);

  const sessionRef     = useRef<PlacementSession | null>(null);
  const occupiedRef    = useRef(occupiedTiles);
  const onPlacedRef    = useRef(onPlaced);
  const onRelocatedRef = useRef(onRelocated);
  const engineUrlRef   = useRef(engineUrl);
  const postingRef     = useRef(false);
  const ghostTileRef   = useRef<GhostTile | null>(null);

  const ghostDivRef    = useRef<HTMLDivElement>(null);
  const ghostImgRef    = useRef<HTMLImageElement>(null);
  const coordLabelRef  = useRef<HTMLDivElement>(null);

  occupiedRef.current    = occupiedTiles;
  onPlacedRef.current    = onPlaced;
  onRelocatedRef.current = onRelocated;
  engineUrlRef.current   = engineUrl;

  useEffect(() => {
    _beginCb = (s) => { sessionRef.current = s; setSession(s); };
    return () => { _beginCb = null; };
  }, []);

  const cancel = useCallback(() => {
    sessionRef.current = null;
    ghostTileRef.current = null;
    setSession(null);
    if (ghostDivRef.current)   ghostDivRef.current.style.display   = 'none';
    if (coordLabelRef.current) coordLabelRef.current.style.display = 'none';
  }, []);

  const doConfirm = useCallback(async () => {
    const g = ghostTileRef.current;
    const s = sessionRef.current;
    if (!g || !g.valid || !s || postingRef.current) return;
    console.log('[Placement] submitting tile:', g.tx, g.ty, 'building:', s.buildingId);
    postingRef.current = true;
    setPosting(true);
    const base = engineUrlRef.current.replace(/\/$/, '');
    try {
      if (s.existingId) {
        await fetch(`${base}/api/game/buildings/${s.existingId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tile_x: g.tx, tile_y: g.ty }),
        });
        s.onSuccess?.();
        onRelocatedRef.current(s.existingId, g.tx, g.ty);
      } else {
        await fetch(`${base}/api/game/buildings`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ building_id: s.buildingId, tile_x: g.tx, tile_y: g.ty }),
        });
        s.onSuccess?.();
        onPlacedRef.current(s.buildingId, g.tx, g.ty);
      }
      cancel();
    } catch {
      // Silent — keep session for retry
    } finally {
      postingRef.current = false;
      setPosting(false);
    }
  }, [cancel]);

  useEffect(() => {
    if (!session) return;

    const onMouseMove = (e: MouseEvent): void => {
      const tile = WorldScene.screenToTile(e.clientX, e.clientY);
      if (!tile) return;

      // Hard zone check — no clamping. Outside zone = invalid, ghost stays at cursor tile.
      const inZone = (
        tile.tx >= PLAYER_ZONE.x1 && tile.tx <= PLAYER_ZONE.x2 &&
        tile.ty >= PLAYER_ZONE.y1 && tile.ty <= PLAYER_ZONE.y2
      );

      const tx = tile.tx;
      const ty = tile.ty;

      // Footprint validity — only meaningful when inside zone
      const entry = MACHINE_BY_ID.get(session.buildingId);
      const fw = entry?.footprintW ?? 1;
      const fh = entry?.footprintH ?? 1;
      let valid = inZone;
      if (valid) {
        outer: for (let dy = 0; dy < fh; dy++) {
          for (let dx = 0; dx < fw; dx++) {
            const ftx = tx + dx; const fty = ty + dy;
            if (ftx > PLAYER_ZONE.x2 || fty > PLAYER_ZONE.y2 ||
                ftx < PLAYER_ZONE.x1 || fty < PLAYER_ZONE.y1 ||
                occupiedRef.current.has(`${ftx},${fty}`)) {
              valid = false; break outer;
            }
          }
        }
      }

      ghostTileRef.current = { tx, ty, valid };

      const screen = WorldScene.tileToScreen(tx, ty);
      if (!screen) return;

      // Ghost size: use the sprite's native pixel dimensions scaled by camera zoom,
      // matching exactly how Phaser renders the placed building (setScale(1.0)).
      const zoom     = getTransform().zoom;
      const HALF_H_WORLD = 8;  // SURFACE_Y offset in world units
      const surfaceY = HALF_H_WORLD * zoom;

      const spriteKey  = entry?.spriteKey ?? session.buildingId;
      const nativeSize = WorldScene.getSpriteSize(spriteKey);
      // Fallback: isometric tile footprint bounding box if sprite not yet loaded
      const HALF_W_WORLD = 16;
      const ghostW = nativeSize ? nativeSize.w * zoom : (fw + fh) * HALF_W_WORLD * zoom;
      const ghostH = nativeSize ? nativeSize.h * zoom : (fw + fh) * HALF_H_WORLD * zoom;

      const div = ghostDivRef.current;
      const img = ghostImgRef.current;
      const lbl = coordLabelRef.current;

      if (div) {
        div.style.display = 'block';
        div.style.width   = `${ghostW}px`;
        div.style.height  = `${ghostH}px`;
        // setOrigin(0.5, 1) means sprite bottom-center is at world pos.
        // World pos = tileToWorld(tx,ty) then y -= SURFACE_Y (8 world units).
        // In screen space: ghost bottom = screen.y - surfaceY, center-x = screen.x
        div.style.left = `${screen.x - ghostW / 2}px`;
        div.style.top  = `${screen.y - ghostH}px`;
      }
      if (img) {
        img.style.filter = valid
          ? 'drop-shadow(0 0 4px rgba(134,239,172,0.6))'
          : 'brightness(0.4) sepia(1) saturate(10) hue-rotate(310deg) drop-shadow(0 0 4px rgba(252,165,165,0.7))';
      }
      if (lbl) {
        lbl.style.display = 'block';
        lbl.style.left    = `${screen.x + ghostW / 2 + 4}px`;
        lbl.style.top     = `${screen.y - ghostH / 2}px`;
        lbl.style.color   = valid ? '#86efac' : '#fca5a5';
        lbl.textContent   = inZone ? `${tx},${ty}` : `${tx},${ty} ✗`;
      }
    };

    const onMouseDown = (e: MouseEvent): void => {
      if (e.button === 0) void doConfirm();
      else if (e.button === 2) cancel();
    };

    const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape') cancel(); };
    const onCtxMenu = (e: Event): void => { e.preventDefault(); };

    window.addEventListener('mousemove',   onMouseMove, { passive: true });
    window.addEventListener('mousedown',   onMouseDown);
    window.addEventListener('keydown',     onKeyDown);
    window.addEventListener('contextmenu', onCtxMenu);
    return () => {
      window.removeEventListener('mousemove',   onMouseMove);
      window.removeEventListener('mousedown',   onMouseDown);
      window.removeEventListener('keydown',     onKeyDown);
      window.removeEventListener('contextmenu', onCtxMenu);
    };
  }, [session, doConfirm, cancel]);

  if (!session) return null;

  const entry    = MACHINE_BY_ID.get(session.buildingId);
  const ghostUrl = spriteUrl(entry?.spriteKey ?? session.buildingId);

  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'all', cursor: 'crosshair', zIndex: 200 }}>

      <div style={{
        position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
        background: 'rgba(0,0,0,0.75)', color: '#aaaaaa',
        fontFamily: 'monospace', fontSize: 11, padding: '4px 12px', borderRadius: 4,
        pointerEvents: 'none', userSelect: 'none',
      }}>
        {session.existingId ? 'RELOCATING' : 'PLACING'}: {session.label}
        &nbsp;·&nbsp; LEFT CLICK to confirm &nbsp;·&nbsp; ESC / RIGHT CLICK to cancel
      </div>

      <div ref={ghostDivRef} style={{
        position: 'absolute', display: 'none', pointerEvents: 'none',
      }}>
        <img ref={ghostImgRef} src={ghostUrl} alt="" draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'contain', opacity: 0.55, userSelect: 'none' }}
        />
      </div>

      <div ref={coordLabelRef} style={{
        position: 'absolute', display: 'none',
        background: 'rgba(0,0,0,0.65)', fontFamily: 'monospace', fontSize: 10,
        padding: '2px 6px', borderRadius: 3, pointerEvents: 'none', userSelect: 'none',
      }} />

      {posting && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          color: '#aaa', fontFamily: 'monospace', fontSize: 12,
          background: 'rgba(0,0,0,0.75)', padding: '6px 14px', borderRadius: 4,
        }}>
          {session.existingId ? 'RELOCATING…' : 'PLACING…'}
        </div>
      )}
    </div>
  );
}
