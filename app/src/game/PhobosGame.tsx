/**
 * PhobosGame — React wrapper for the PHOBOS World Phaser game.
 *
 * - Created once on mount, never destroyed (Phaser instance persists).
 * - Canvas at z-index: 0, pointer-events: none when UI is focused.
 * - Toggle focus with backtick (`) hotkey or the game toggle button.
 * - 60% opacity when UI focused, 100% when game focused.
 * - FPS: 30 background, 60 foreground.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import * as Phaser from 'phaser';
import { WorldScene } from './WorldScene';
import { ArenaScene }  from './ArenaScene';
import { connectGameSSE, disconnectGameSSE } from './GameSSEClient';
import { CharacterCreator } from './CharacterCreator';
import { BattleOverlay } from './BattleOverlay';
import { InventoryPanel } from './InventoryPanel';
import { ELEMENT_COLORS, CLASS_DEFINITIONS, type PlayerBuild, type ClassName, type BodyType, type ElementType, type EquippedGear } from './PlayerClasses';
import type { GameItem, EquipSlot } from './ItemDefinitions';
import type { PlayerConfig } from './PlayerSprite';
import { useAppStore } from '@/store/useAppStore';
import { registerDayNightPipeline } from './PhobosPostProcess';
import { GameHUD } from './GameHUD';
import { AllyHUD } from './AllyHUD';
import type { AllyState } from './AllyHUD';
import { ShopPanel } from './ShopPanel';
import { CraftingMenu } from './CraftingMenu';
import { KeybindPanel } from './KeybindPanel';
import { HousePanel } from './HousePanel';
import { PartyPanel }     from './PartyPanel';
import type { CombatMode } from './PlayerCombatController';
import { BuildingPlacementOverlayPanel, BuildingPlacementOverlay } from './BuildingPlacementOverlay';
import { MachineMenuPanel, type MachineRecord } from './MachineMenuPanel';
import { RCSPanel } from './RCSPanel';
import { FabShopPanel } from './FabShopPanel';
import { DevInventoryPanel, MouseDebugOverlay } from './DevInventoryPanel';
import { MACHINE_BY_ID, getFootprintTiles } from './HubBuildingCatalog';
import type { RarityTier } from './ItemDefinitions';
import './world.css';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

/** Phaser game config — created once. */
function createGameConfig(parent: HTMLElement): Phaser.Types.Core.GameConfig {
  return {
    type: Phaser.AUTO,
    parent,
    width: parent.clientWidth,
    height: parent.clientHeight,
    transparent: true,
    scene: [WorldScene, ArenaScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    fps: {
      target: 30,
      forceSetTimeOut: false,
    },
    render: {
      pixelArt: true,
      antialias: false,
      roundPixels: true,
    },
    audio: {
      disableWebAudio: true,
      noAudio: true,
    },
    input: {
      keyboard: {
        // capture:[] prevents Phaser calling preventDefault on WASD/arrows
        // so DOM inputs receive those keys normally.
        capture: [],
      },
      mouse: true,
      touch: true,
    },
    banner: false,
  };
}

export function PhobosGame() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const hasCharacter = useRef(false);
  const enterCombatRef = useRef<(() => void) | null>(null);
  // gameFocused and phobosCoins now live in useAppStore — HeaderBar reads them directly
  const gameFocused    = useAppStore((s) => s.gameFocused);
  const setGameFocused = useAppStore((s) => s.setGameFocused);
  const setPhobosCoins = useAppStore((s) => s.setPhobosCoins);
  // Ref mirrors gameFocused so keydown / toggleFocus closures always see current value
  const gameFocusedRef = useRef(false);
  const [showCharCreate, setShowCharCreate] = useState(false);
  const [editBuild, setEditBuild] = useState<PlayerBuild | null>(null);
  const [showPerfMenu, setShowPerfMenu] = useState(false);
  const [targetFps, setTargetFps] = useState(60);
  // vizMode: 'off' hides canvas, 'perf' is default, 'high' enables post-process
  const [vizMode, setVizMode] = useState<'off'|'perf'|'high'>('perf');
  const [zoomLevel, setZoomLevel] = useState(2);
  const [integerZoom, setIntegerZoom] = useState(false);
  const [inCombat, setInCombat] = useState(false);
  const [inArena,  setInArena]  = useState(false);
  const [inExZone, setInExZone] = useState(false);
  const [camOffX,  setCamOffX]  = useState(0);
  const [camOffY,  setCamOffY]  = useState(0);
  const [occupiedTiles,   setOccupiedTiles]   = useState<Set<string>>(new Set());
  const [placedBuildingIds, setPlacedBuildingIds] = useState<Set<string>>(new Set());
  const [builtBuildingIds,  setBuiltBuildingIds]  = useState<Set<string>>(new Set());
  const [activeMachineRec,  setActiveMachineRec]  = useState<MachineRecord | null>(null);
  const [showFabShop,       setShowFabShop]        = useState(false);
  const [showDevPanel,      setShowDevPanel]        = useState(false);
  const [showInventory, setShowInventory] = useState(false);
  const [potionCounts, setPotionCounts] = useState({ healing: 0, spirit: 0 });
  const cachedBuild  = useRef<PlayerBuild | null>(null);
  // activeBuild mirrors cachedBuild.current and drives React renders (InventoryPanel, etc.)
  const [activeBuild, setActiveBuild] = useState<PlayerBuild | null>(null);

  // ── HUD state (driven by PlayerCombatController callbacks) ──────────────
  const [hudHp,              setHudHp]            = useState(100);
  const [hudMaxHp,           setHudMaxHp]          = useState(100);
  const [hudSpirit,          setHudSpirit]          = useState(50);
  const [hudMaxSpirit,       setHudMaxSpirit]       = useState(50);
  const [hudCooldowns,       setHudCooldowns]       = useState<[number,number,number]>([0,0,0]);
  const [hudCombatMode,      setHudCombatMode]      = useState<CombatMode>('melee');
  const [hudChargeProgress,  setHudChargeProgress]  = useState(0);
  const [hudIsReady,         setHudIsReady]          = useState(false);
  const [showKeybinds,       setShowKeybinds]        = useState(false);
  const [showShop,           setShowShop]            = useState(false);
  const [showCrafting,       setShowCrafting]         = useState(false);
  const [showHousePanel, setShowHousePanel] = useState(false);
  const [showParty,     setShowParty]     = useState(false);
  const [ether,              setEther]                = useState(0);
  const [fullInventory,      setFullInventory]        = useState<GameItem[]>([]);

  // ── Ally HUD state ─────────────────────────────────────────────────────
  const defaultAllyState = (): AllyState => ({ hp: 100, maxHp: 100, spirit: 60, offline: false, mode: 'defensive', inParty: false });
  const [allyStates, setAllyStates] = useState<Record<string, AllyState>>({
    sayon: defaultAllyState(),
    seren: { ...defaultAllyState(), maxHp: 75, hp: 75, spirit: 90 },
    sybil: { ...defaultAllyState(), maxHp: 90, hp: 90, spirit: 70, offline: true },
  });

  // Create Phaser instance once
  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    const config = createGameConfig(containerRef.current);
    const game = new Phaser.Game(config);
    gameRef.current = game;

    // Register post-process pipeline once renderer is ready.
    // The pipeline is only applied to the camera inside WorldScene.create()
    // when highPerf is enabled — registration here just makes it available.
    game.events.once('ready', () => {
      if (game.renderer.type === Phaser.WEBGL) {
        registerDayNightPipeline(game);
      }
    });

    // Connect to game SSE stream
    connectGameSSE();

    // Register live coin counter callback
    WorldScene.onCoinCollected((total) => setPhobosCoins(total));

    // Register zoom change callback (from mousewheel)
    WorldScene.onZoomChanged((z) => setZoomLevel(z));

    // Register building interaction callbacks.
    // setState dispatchers are stable; enterCombat is accessed via ref to avoid stale closure.
    WorldScene.onOpenShop(    () => { setShowShop(true);     setShowCrafting(false); });
    WorldScene.onOpenCrafting(() => { setShowCrafting(true); setShowShop(false);     });
    WorldScene.onOpenBattle(() => { enterCombatRef.current?.(); });
    WorldScene.onOpenArena(() => {
      if (!cachedBuild.current || !gameRef.current) return;
      setInArena(true);
      ArenaScene.launch(gameRef.current, cachedBuild.current, WorldScene.getPartySize());
    });
    ArenaScene.onArenaExit((_fled) => {
      setInArena(false);
    });
    WorldScene.onOpenHouse(   () => { setShowHousePanel(true); });
    WorldScene.onOpenGarage(  () => { /* stub — garage panel not yet built */ });

    WorldScene.onOpenMachine((rec) => setActiveMachineRec(rec));
    WorldScene.onOpenFabShop(() => setShowFabShop(true));

    // Fetch placed buildings on mount — seed occupiedTiles and id sets
    fetch(`${ENGINE_URL}/api/game/buildings`)
      .then(r => r.json() as Promise<Array<{
        id: string; building_id: string; tile_x: number; tile_y: number;
        state: 'blueprint' | 'building' | 'built'; config: string;
      }>>)
      .then(buildings => {
        const occupied  = new Set<string>();
        const placed    = new Set<string>();
        const built     = new Set<string>();
        for (const b of buildings) {
          placed.add(b.building_id);
          if (b.state === 'built') built.add(b.building_id);
          const entry = MACHINE_BY_ID.get(b.building_id);
          if (entry) {
            for (const { tx, ty } of getFootprintTiles(b.tile_x, b.tile_y, entry.footprintW, entry.footprintH)) {
              occupied.add(`${tx},${ty}`);
            }
          }
        }
        setOccupiedTiles(occupied);
        setPlacedBuildingIds(placed);
        setBuiltBuildingIds(built);
      })
      .catch(() => {});

    // Zone threshold — enables combat abilities when player enters exploration zone
    WorldScene.onZoneEnter(() => { setInExZone(true);  });
    WorldScene.onZoneExit( () => { setInExZone(false); });
    WorldScene.onCameraMove((x, y) => { setCamOffX(x); setCamOffY(y); });
    WorldScene.onOpenParty(() => setShowParty(p => !p));
    WorldScene.onAllyInvite((persona) => {
      setAllyStates(prev => ({
        ...prev,
        [persona]: { ...prev[persona]!, inParty: true },
      }));
    });
    WorldScene.onAllyRelease((persona) => {
      setAllyStates(prev => ({
        ...prev,
        [persona]: { ...prev[persona]!, inParty: false },
      }));
    });

    // Seed initial camera position — onCameraMove only fires on movement,
    // so the initial scrollX/Y would otherwise stay at 0.
    const seedCamera = () => {
      const ws = gameRef.current?.scene.getScene('WorldScene') as WorldScene | null;
      const cam = (ws as any)?.cameras?.main;
      if (cam) { setCamOffX(cam.scrollX); setCamOffY(cam.scrollY); }
    };
    // Try immediately and again after a short delay in case scene isn't ready yet
    seedCamera();
    const seedTimer = setTimeout(seedCamera, 500);

    // Set initial body class for UI opacity
    document.body.classList.add('phobos-world-bg');

    // Fetch initial player state — track character existence, cache build
    fetch(`${ENGINE_URL}/api/game/player`)
      .then(r => r.json())
      .then(data => {
        hasCharacter.current = !!data.name;
        setPhobosCoins(data.phobos_coins ?? 0);
        if (data.name) {
          cachedBuild.current = {
            name: data.name,
            class: (data.player_class ?? 'fighter') as ClassName,
            body: (data.body_type ?? 'a') as BodyType,
            element: (data.element ?? 'plasma') as ElementType,
            level: data.level ?? 1,
            xp: data.experience ?? 0,
            bonusPoints: {
              str: data.bonus_str ?? 0, dex: data.bonus_dex ?? 0,
              int: data.bonus_int ?? 0, agi: data.bonus_agi ?? 0,
              vit: data.bonus_vit ?? 0,
            },
            unspentPoints:  data.unspent_points  ?? 5,
            skillPoints:    data.skill_points    ?? 1,
            unlockedNodes: (() => {
              try { return JSON.parse(data.unlocked_nodes ?? '[]'); }
              catch { return []; }
            })(),
          };
          setActiveBuild(cachedBuild.current);

          // Restore persisted HP — controller may not be ready yet, poll until it is
          if (data.current_hp != null) {
            const savedHp = data.current_hp as number;
            const tryRestore = () => {
              const game = gameRef.current;
              const scene = game?.scene.getScene('WorldScene') as any;
              if (scene?._combatController) {
                scene.restoreHp(savedHp);
              } else {
                setTimeout(tryRestore, 200);
              }
            };
            setTimeout(tryRestore, 200);
          }
        }
      })
      .catch(() => {});

    // Fetch ether balance
    fetch(`${ENGINE_URL}/api/game/player`)
      .then(r => r.json())
      .then(d => { if (d.ether != null) setEther(d.ether); })
      .catch(() => {});

    // Fetch full inventory
    fetch(`${ENGINE_URL}/api/game/inventory`)
      .then(r => r.json())
      .then((rows: Array<{ data: string }>) => {
        const items: GameItem[] = [];
        for (const row of rows) {
          try { items.push(JSON.parse(row.data)); } catch { /* skip */ }
        }
        setFullInventory(items);
      })
      .catch(() => {});

    // Fetch equipped items and hydrate cachedBuild.equipment so derivedStats
    // picks up ring bonuses, weapon stats, armor defense, and freq osc passives
    // from the very first frame of play.
    fetch(`${ENGINE_URL}/api/game/inventory/equipped`)
      .then(r => r.json())
      .then((rows: Array<{ data: string; slot: string; id: string }>) => {
        const gear: Partial<Record<EquipSlot, GameItem>> = {};
        for (const row of rows) {
          try {
            const item = JSON.parse(row.data) as GameItem;
            item.id      = row.id;
            item.equipped = true;
            if (item.slot) gear[item.slot] = item;
          } catch { /* skip malformed */ }
        }
        applyEquipmentToBuild(gear);
      })
      .catch(() => {});

    // Fetch potion counts from inventory
    fetch(`${ENGINE_URL}/api/game/inventory`)
      .then(r => r.json())
      .then((rows: Array<{ data: string }>) => {
        let healing = 0;
        let spirit = 0;
        for (const row of rows) {
          try {
            const item = JSON.parse(row.data);
            if (item.type === 'consumable' && item.baseId === 'healing_potion') healing += item.quantity ?? 1;
            if (item.type === 'consumable' && item.baseId === 'spirit_potion') spirit += item.quantity ?? 1;
          } catch { /* skip */ }
        }
        setPotionCounts({ healing, spirit });
      })
      .catch(() => {});

    // Cleanup only on full unmount (which shouldn't happen — game persists)
    return () => {
      clearTimeout(seedTimer);
      disconnectGameSSE();
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
      }
    };
  }, []);

  // Focus toggle — backtick key, I for inventory
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      // When game is focused, prevent Space/Alt from reaching the DOM.
      // Space activates focused buttons; Alt opens browser menus.
      // These keys are consumed by Phaser for jump and ready-stance.
      if (gameFocusedRef.current) {
        if (e.code === 'Space' || e.key === 'Alt') {
          e.preventDefault();
        }
      }

      if (e.key === '`' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        const enteringWorld = !gameFocusedRef.current;
        if (enteringWorld && !hasCharacter.current) {
          setShowCharCreate(true);
        } else {
          setGameFocused(enteringWorld);
        }
      }

      if ((e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        setShowInventory(prev => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Update game FPS and input based on focus state
  useEffect(() => {
    const game = gameRef.current;
    if (!game) return;

    // Tell WorldScene about input state
    const scene      = game.scene.getScene('WorldScene') as WorldScene | null;
    const arenaScene = game.scene.getScene('ArenaScene') as any;
    if (scene) scene.setInputEnabled(gameFocused);
    if (arenaScene?.setInputEnabled) arenaScene.setInputEnabled(gameFocused);

    if (gameFocused) {
      game.loop.targetFps = targetFps;
      game.input.enabled = true;
      document.body.classList.add('phobos-world-focused');
      document.body.classList.remove('phobos-world-bg');
    } else {
      game.loop.targetFps = 30;
      game.input.enabled = false;
      document.body.classList.remove('phobos-world-focused');
      document.body.classList.add('phobos-world-bg');
    }
  }, [gameFocused, targetFps]);

  // Poll PlayerCombatController state each animation frame when world is focused
  useEffect(() => {
    if (!gameFocused) return;
    let rafId: number;
    const poll = () => {
      const game = gameRef.current;
      if (game) {
        // In arena: read from the arena controller (WorldScene is sleeping).
        // In hub/zone: read from WorldScene's controller as normal.
        const cc = inArena
          ? ArenaScene.getController()
          : (game.scene.getScene('WorldScene') as any)?._combatController;
        if (cc) {
          setHudHp(Math.ceil(cc.hpCurrent));
          setHudMaxHp(cc.hpMax);
          setHudSpirit(Math.ceil(cc.spiritCurrent));
          setHudMaxSpirit(cc.spiritMax);
          setHudCooldowns([...cc.abilityCooldowns] as [number,number,number]);
          setHudCombatMode(cc.combatMode);
          setHudChargeProgress(cc.chargeProgress);
          setHudIsReady(cc.isInCombatReadiness);
        }
        // Ally states only meaningful while WorldScene is active
        if (!inArena) {
          const scene = game.scene.getScene('WorldScene') as any;
          const allyNames = ['sayon', 'seren', 'sybil'];
          const updated: Record<string, AllyState> = {};
          let anyChange = false;
          for (const name of allyNames) {
            const s = scene?.getAllyState?.(name);
            if (s) { updated[name] = s; anyChange = true; }
          }
          if (anyChange) setAllyStates(prev => {
            const next = { ...prev };
            for (const name of allyNames) {
              if (updated[name]) {
                next[name] = { ...updated[name]!, inParty: prev[name]?.inParty ?? false };
              }
            }
            return next;
          });
        }
      }
      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
  }, [gameFocused, inArena]);

  // Persist HP to server every 5 s while world is focused
  useEffect(() => {
    if (!gameFocused) return;
    const id = setInterval(() => {
      const game = gameRef.current;
      if (!game) return;
      const cc = (game.scene.getScene('WorldScene') as any)?._combatController;
      if (!cc || cc.hpCurrent <= 0) return;
      fetch(`${ENGINE_URL}/api/game/player/hp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hp: cc.hpCurrent }),
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [gameFocused]);

  // Apply FPS change to running game
  const handleFpsChange = useCallback((fps: number) => {
    setTargetFps(fps);
    const game = gameRef.current;
    if (game && gameFocused) game.loop.targetFps = fps;
  }, [gameFocused]);

  // Change visualisation mode
  const handleVizMode = useCallback((mode: 'off'|'perf'|'high') => {
    setVizMode(mode);
    const game = gameRef.current;
    if (!game) return;

    // Canvas visibility
    const canvas = game.canvas;
    if (canvas) {
      canvas.style.display = mode === 'off' ? 'none' : 'block';
    }

    if (mode !== 'off') {
      const scene = game.scene.getScene('WorldScene') as WorldScene | null;
      if (scene) {
        scene.setHighPerformance(mode === 'high');
        // Refresh scale manager so canvas fills container after show
        try { game.scale.refresh(); } catch { /* v4 compat */ }
      }
    }
  }, []);

  // Keep gameFocusedRef in sync with store value
  useEffect(() => { gameFocusedRef.current = gameFocused; }, [gameFocused]);

  // Toggle button handler — gate world mode behind character creation
  const toggleFocus = useCallback(() => {
    const enteringWorld = !gameFocusedRef.current;
    if (enteringWorld && !hasCharacter.current) {
      setShowCharCreate(true);
      return;
    }
    setGameFocused(enteringWorld);
  }, [setGameFocused]);

  // Open character editor with current build loaded from backend
  const openCharacterEditor = useCallback(async () => {
    try {
      const resp = await fetch(`${ENGINE_URL}/api/game/player`);
      const data = await resp.json();
      if (data.name) {
        const build: PlayerBuild = {
          name: data.name,
          class: (data.player_class ?? 'fighter') as ClassName,
          body: (data.body_type ?? 'a') as BodyType,
          element: (data.element ?? 'plasma') as ElementType,
          level: data.level ?? 1,
          xp: data.experience ?? 0,
          bonusPoints: {
            str: data.bonus_str ?? 0,
            dex: data.bonus_dex ?? 0,
            int: data.bonus_int ?? 0,
            agi: data.bonus_agi ?? 0,
            vit: data.bonus_vit ?? 0,
          },
          unspentPoints:  data.unspent_points  ?? 5,
          skillPoints:    data.skill_points    ?? 1,
          unlockedNodes: (() => {
            try { return JSON.parse(data.unlocked_nodes ?? '[]'); }
            catch { return []; }
          })(),
        };
        setActiveBuild(build);
        setEditBuild(build);
        setShowCharCreate(true);
      }
    } catch { /* silent */ }
  }, []);

  // Merge an equipped-item map into cachedBuild.equipment and push the update
  // into the live combat controller so stats take effect immediately.
  const applyEquipmentToBuild = useCallback((gear: Partial<Record<EquipSlot, GameItem>>) => {
    if (!cachedBuild.current) return;
    const equipment: EquippedGear = {
      melee:          gear['melee'],
      ranged:         gear['ranged'],
      helm:           gear['helm'],
      body:           gear['body'],
      legs:           gear['legs'],
      leftRing:       gear['leftRing'],
      rightRing:      gear['rightRing'],
      abilityCrystal: gear['abilityCrystal'],
    };
    const updated: PlayerBuild = { ...cachedBuild.current, equipment };
    cachedBuild.current = updated;
    setActiveBuild(updated);
    // Push into whichever scene is currently active
    const game = gameRef.current;
    if (game) {
      const world = game.scene.getScene('WorldScene') as any;
      if (world?.combatController) world.combatController.updateBuild(updated);
      // Hot-swap weapon sprite when melee item changes
      world?.updateWeaponSprite?.(gear['melee']);
      ArenaScene.getController()?.updateBuild?.(updated);
    }
  }, []);

  // Character creation/edit confirm handler
  const handleBuildConfirm = useCallback(async (build: PlayerBuild) => {
    const elementColor = ELEMENT_COLORS[build.element];
    const config: PlayerConfig = {
      name: build.name,
      element: build.element,
      weapon: CLASS_DEFINITIONS[build.class].startingMelee.name,
      laserColor: elementColor.hex,
      playerClass: build.class,
      bodyType: build.body,
    };

    // Persist to backend
    try {
      await fetch(`${ENGINE_URL}/api/game/player`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: build.name,
          element: build.element,
          weapon: config.weapon,
          laser_color: config.laserColor,
          player_class: build.class,
          body_type: build.body,
          level: build.level,
          xp: build.xp,
          bonus_str: build.bonusPoints.str,
          bonus_dex: build.bonusPoints.dex,
          bonus_int: build.bonusPoints.int,
          bonus_agi: build.bonusPoints.agi,
          bonus_vit: build.bonusPoints.vit,
          unspent_points:  build.unspentPoints,
          skill_points:    build.skillPoints    ?? 1,
          unlocked_nodes:  JSON.stringify(build.unlockedNodes ?? []),
        }),
      });
    } catch { /* silent */ }

    // Update the Phaser scene
    const game = gameRef.current;
    if (game) {
      const scene = game.scene.getScene('WorldScene') as WorldScene | null;
      if (scene) scene.configurePlayer(config);
    }

    hasCharacter.current = true;
    cachedBuild.current = build;
    setActiveBuild(build);
    setShowCharCreate(false);
    setEditBuild(null);
    setGameFocused(true); // enter world mode after character creation

    // Update HUD max values when build changes
    const { derivedStats: ds } = await import('./PlayerClasses');
    const d = ds(build);
    setHudMaxHp(d.maxHp);
    setHudMaxSpirit(d.maxSpirit);
    setHudHp(d.maxHp);
    setHudSpirit(d.maxSpirit);
  }, []);

  // Enter combat from Battle Hall
  const enterCombat = useCallback(() => {
    if (!cachedBuild.current) return;
    setInCombat(true);
    // Disable world input during combat
    const game = gameRef.current;
    if (game) {
      const scene = game.scene.getScene('WorldScene') as WorldScene | null;
      if (scene) scene.setInputEnabled(false);
    }
  }, []);
  enterCombatRef.current = enterCombat;

  // Keep WorldScene zone guard in sync with combat state
  useEffect(() => { WorldScene.setCombatActive(inCombat); }, [inCombat]);

  // Exit combat — collect rewards and persist loot
  const exitCombat = useCallback(async (xpEarned: number, coinsEarned: number, droppedItems: GameItem[]) => {
    setInCombat(false);
    if (coinsEarned > 0) {
      try {
        const resp = await fetch(`${ENGINE_URL}/api/game/coins/collect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: coinsEarned }),
        });
        const data = await resp.json();
        if (data.phobos_coins != null) setPhobosCoins(data.phobos_coins);
      } catch { /* silent */ }
    }
    // Persist dropped items to inventory
    for (const item of droppedItems) {
      try {
        await fetch(`${ENGINE_URL}/api/game/inventory/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            item_id: item.id,
            target: 'player',
            slot: item.slot,
            rarity: item.rarity,
            data: JSON.stringify(item),
          }),
        });
        // Track potion counts for combat UI
        if (item.type === 'potion') {
          const isHeal = item.name.startsWith('HP');
          if (isHeal) {
            setPotionCounts(prev => ({ ...prev, healing: prev.healing + item.quantity }));
          } else {
            setPotionCounts(prev => ({ ...prev, spirit: prev.spirit + item.quantity }));
          }
        }
      } catch { /* silent */ }
    }
    // Persist XP to player record and check for level-up
    if (xpEarned > 0 && cachedBuild.current) {
      try {
        const resp = await fetch(`${ENGINE_URL}/api/game/player/xp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ xp: xpEarned }),
        });
        const data = await resp.json();
        // Backend returns new level if leveled up
        if (data.level && data.level > cachedBuild.current.level) {
          const levelsGained  = data.level - cachedBuild.current.level;
          const { SKILL_POINTS_PER_LEVEL } = await import('./PlayerClasses');
          const updated: PlayerBuild = {
            ...cachedBuild.current,
            level:         data.level,
            xp:            data.xp ?? cachedBuild.current.xp + xpEarned,
            unspentPoints: (cachedBuild.current.unspentPoints ?? 0) + levelsGained * 3,
            skillPoints:   (cachedBuild.current.skillPoints   ?? 0) + levelsGained * SKILL_POINTS_PER_LEVEL,
          };
          cachedBuild.current = updated;
          setActiveBuild(updated);
          // Persist new point totals
          await fetch(`${ENGINE_URL}/api/game/player`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              level:          updated.level,
              xp:             updated.xp,
              unspent_points: updated.unspentPoints,
              skill_points:   updated.skillPoints,
            }),
          });
        } else if (cachedBuild.current) {
          // No level-up — just update local XP
          const updated: PlayerBuild = { ...cachedBuild.current, xp: cachedBuild.current.xp + xpEarned };
          cachedBuild.current = updated;
          setActiveBuild(updated);
        }
      } catch { /* silent */ }
    }

    // Add dropped items to local inventory state
    if (droppedItems.length > 0) {
      setFullInventory(prev => [...prev, ...droppedItems]);
    }

    // Re-enable world input
    const game = gameRef.current;
    if (game) {
      const scene = game.scene.getScene('WorldScene') as WorldScene | null;
      if (scene) scene.setInputEnabled(true);
    }
  }, []);

  // Shared button style factory — larger, consistent
  function btnStyle(active: boolean): React.CSSProperties {
    return {
      padding: '7px 14px',
      fontSize: '12px',
      fontFamily: 'monospace',
      fontWeight: 700,
      background: active ? 'rgba(245,158,11,0.88)' : 'rgba(20,20,20,0.82)',
      color: active ? '#000' : '#ccc',
      border: `1px solid ${active ? '#f59e0b' : '#3a3a3a'}`,
      borderRadius: 5,
      cursor: 'pointer',
      backdropFilter: 'blur(6px)',
      transition: 'all 0.15s ease',
      whiteSpace: 'nowrap' as const,
      lineHeight: 1,
    };
  }

  return (
    <>
      {/* Debug overlay — always mounted, only visible when activated */}
      <MouseDebugOverlay />
      {/* Phaser canvas container — sits behind all UI */}
      <div
        ref={containerRef}
        id="phobos-game-container"
        onContextMenu={e => e.preventDefault()}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 0,
          // Hide entire container when vizMode is 'off'
          display: vizMode === 'off' ? 'none' : 'block',
          opacity: gameFocused ? 1.0 : 0.6,
          pointerEvents: gameFocused ? 'auto' : 'none',
          transition: 'opacity 0.3s ease',
          lineHeight: 0,
          fontSize: 0,
        }}
      />

      {/* Coin counter moved to HeaderBar — reads from useAppStore.phobosCoins */}

      {/* ── Isometric compass — bottom-right, always visible in world mode ── */}
      {gameFocused && (
        <div style={{
          position: 'fixed', bottom: 56, right: 16, zIndex: 50,
          pointerEvents: 'none', opacity: 0.55,
        }}>
          <svg width="72" height="72" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">
            {/* Outer ring */}
            <circle cx="36" cy="36" r="32" fill="none" stroke="#1a3a1a" strokeWidth="1.5"/>
            {/* Iso compass: N=top-right, E=bottom-right, S=bottom-left, W=top-left */}
            {/* N arrow — top-right */}
            <polygon points="36,36 58,14 54,22 46,30" fill="#22c55e"/>
            <text x="57" y="13" fill="#22c55e" fontSize="9" fontFamily="monospace" fontWeight="bold">N</text>
            {/* S arrow — bottom-left */}
            <polygon points="36,36 14,58 18,50 26,42" fill="#3a3a3a"/>
            <text x="7" y="66" fill="#3a3a3a" fontSize="9" fontFamily="monospace">S</text>
            {/* E arrow — bottom-right */}
            <polygon points="36,36 58,58 50,54 42,46" fill="#3a3a3a"/>
            <text x="57" y="66" fill="#3a3a3a" fontSize="9" fontFamily="monospace">E</text>
            {/* W arrow — top-left */}
            <polygon points="36,36 14,14 22,18 30,26" fill="#3a3a3a"/>
            <text x="7" y="13" fill="#3a3a3a" fontSize="9" fontFamily="monospace">W</text>
            {/* Centre dot */}
            <circle cx="36" cy="36" r="2.5" fill="#22c55e"/>
          </svg>
        </div>
      )}

      {/* ── Bottom toolbar ── */}
      <div style={{
        position: 'fixed', bottom: 12, left: 12, zIndex: 50,
        display: 'flex', gap: 6, alignItems: 'center',
      }}>
        {gameFocused && (
          <>
            <button onClick={() => { setShowPerfMenu(p => !p); setShowKeybinds(false); }}
              style={btnStyle(showPerfMenu)} title="Performance settings">⚙</button>
            <button onClick={() => { setShowKeybinds(p => !p); setShowPerfMenu(false); }}
              style={btnStyle(showKeybinds)} title="Keybinds">⌨</button>
            <button onClick={openCharacterEditor}
              style={btnStyle(false)} title="Edit character">📋</button>
            <button onClick={enterCombat}
              style={btnStyle(false)} title="Battle Hall">⚔</button>
            <button onClick={() => setShowInventory(true)}
              style={btnStyle(false)} title="Inventory (I)">🎒</button>
            <button onClick={() => { setShowShop(p => !p); setShowCrafting(false); }}
              style={btnStyle(showShop)} title="Shop">🏪</button>
            <button onClick={() => { setShowCrafting(p => !p); setShowShop(false); }}
              style={btnStyle(showCrafting)} title="Crafting Station">⚒</button>
            <button onClick={() => setShowDevPanel(p => !p)}
              style={btnStyle(showDevPanel)} title="Dev: Inventory">⚙̈</button>
          </>
        )}
      </div>

      {/* Performance menu overlay */}
      {showPerfMenu && gameFocused && (
        <div
          style={{
            position: 'fixed',
            bottom: 44,
            left: 12,
            zIndex: 60,
            padding: '12px 16px',
            background: 'rgba(14, 14, 14, 0.92)',
            border: '1px solid #2a2a2a',
            borderRadius: 6,
            fontFamily: 'monospace',
            fontSize: 10,
            color: '#aaa',
            backdropFilter: 'blur(8px)',
            width: 220,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b', marginBottom: 10, letterSpacing: '1px' }}>
            PERFORMANCE
          </div>

          {/* FPS slider */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ color: '#666' }}>Target FPS</span>
              <span style={{ color: '#ddd', fontWeight: 700 }}>{targetFps}</span>
            </div>
            <input
              type="range"
              min={15}
              max={144}
              step={1}
              value={targetFps}
              onChange={e => handleFpsChange(parseInt(e.target.value))}
              style={{ width: '100%', accentColor: '#f59e0b' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: '#333' }}>
              <span>15</span><span>30</span><span>60</span><span>144</span>
            </div>
          </div>

          {/* Zoom slider */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ color: '#666' }}>Zoom</span>
              <span style={{ color: '#ddd', fontWeight: 700 }}>{integerZoom ? Math.round(zoomLevel) : zoomLevel.toFixed(1)}×</span>
            </div>
            <input
              type="range"
              min={1}
              max={5}
              step={integerZoom ? 1 : 0.25}
              value={zoomLevel}
              onChange={e => {
                const z = parseFloat(e.target.value);
                setZoomLevel(z);
                const game = gameRef.current;
                if (game) {
                  const scene = game.scene.getScene('WorldScene') as WorldScene | null;
                  if (scene) scene.setZoom(z);
                }
              }}
              style={{ width: '100%', accentColor: '#f59e0b' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: '#333' }}>
              <span>1×</span><span>2×</span><span>3×</span><span>5×</span>
            </div>
          </div>

          {/* Integer zoom toggle */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '6px 0',
              borderTop: '1px solid #1a1a1a',
              marginBottom: 6,
            }}
          >
            <div>
              <div style={{ color: '#888', marginBottom: 2 }}>Integer Scaling</div>
              <div style={{ fontSize: 8, color: '#444' }}>Pixel-perfect at 1×, 2×, 3×…</div>
            </div>
            <button
              onClick={() => {
                const next = !integerZoom;
                setIntegerZoom(next);
                const game = gameRef.current;
                if (game) {
                  const scene = game.scene.getScene('WorldScene') as WorldScene | null;
                  if (scene) {
                    scene.setIntegerZoom(next);
                    setZoomLevel(scene.getZoom());
                  }
                }
              }}
              style={{
                padding: '3px 10px',
                fontSize: 9,
                fontFamily: 'monospace',
                background: integerZoom ? '#f59e0b' : '#1a1a1a',
                color: integerZoom ? '#000' : '#555',
                border: `1px solid ${integerZoom ? '#f59e0b' : '#333'}`,
                borderRadius: 3,
                cursor: 'pointer',
                fontWeight: 700,
              }}
            >
              {integerZoom ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* Visualisation mode — OFF / PERF / HIGH */}
          <div style={{ borderTop: '1px solid #1a1a1a', paddingTop: 8 }}>
            <div style={{ color: '#888', marginBottom: 6 }}>Visuals</div>
            <div style={{ display: 'flex', gap: 5 }}>
              {(['off','perf','high'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => handleVizMode(mode)}
                  style={{
                    flex: 1,
                    padding: '6px 0',
                    fontSize: 10,
                    fontFamily: 'monospace',
                    fontWeight: 700,
                    background: vizMode === mode ? '#f59e0b' : '#1a1a1a',
                    color: vizMode === mode ? '#000' : '#555',
                    border: `1px solid ${vizMode === mode ? '#f59e0b' : '#333'}`,
                    borderRadius: 3,
                    cursor: 'pointer',
                    textTransform: 'uppercase' as const,
                  }}
                >
                  {mode}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 8, color: '#333', marginTop: 4 }}>
              {vizMode === 'off'  && 'Canvas hidden — zero GPU cost'}
              {vizMode === 'perf' && 'Default — effects, no shader pass'}
              {vizMode === 'high' && 'Post-process, particles, shadows'}
            </div>
          </div>
        </div>
      )}

      {/* Keybind panel */}
      {showKeybinds && gameFocused && (
        <div
          style={{
            position: 'fixed',
            bottom: 56,
            left: 12,
            zIndex: 60,
            padding: '12px 16px',
            background: 'rgba(14,14,14,0.94)',
            border: '1px solid #2a2a2a',
            borderRadius: 6,
            fontFamily: 'monospace',
            backdropFilter: 'blur(8px)',
            width: 240,
            maxHeight: '70vh',
            overflowY: 'auto',
          }}
        >
          <KeybindPanel gameRef={gameRef} />
        </div>
      )}

      {/* Character creation / editor */}
      {showCharCreate && (
        <CharacterCreator
          mode={editBuild ? 'edit' : 'create'}
          initialBuild={editBuild ?? undefined}
          onConfirm={handleBuildConfirm}
          onCancel={() => { setShowCharCreate(false); setEditBuild(null); }}
        />
      )}

      {/* Building placement overlay — always mounted in world mode */}
      {gameFocused && (
        <BuildingPlacementOverlayPanel
          engineUrl={ENGINE_URL}
          occupiedTiles={occupiedTiles}
          onPlaced={(buildingId, tileX, tileY) => {
            const entry = MACHINE_BY_ID.get(buildingId);
            if (entry) {
              setOccupiedTiles(prev => {
                const next = new Set(prev);
                for (const { tx, ty } of getFootprintTiles(tileX, tileY, entry.footprintW, entry.footprintH)) {
                  next.add(`${tx},${ty}`);
                }
                return next;
              });
            }
            setPlacedBuildingIds(prev => new Set(prev).add(buildingId));
            const scene = gameRef.current?.scene.getScene('WorldScene') as WorldScene | null;
            scene?.loadPlayerBuildings?.();
          }}
          onRelocated={(recordId, tileX, tileY) => {
            // Full rebuild — easiest correct approach for relocated footprint
            const scene = gameRef.current?.scene.getScene('WorldScene') as WorldScene | null;
            scene?.loadPlayerBuildings?.();
            // Re-fetch to get accurate occupiedTiles after move
            fetch(`${ENGINE_URL}/api/game/buildings`)
              .then(r => r.json() as Promise<Array<{ building_id: string; tile_x: number; tile_y: number; state: string }>>)
              .then(buildings => {
                const occupied = new Set<string>();
                for (const b of buildings) {
                  const entry = MACHINE_BY_ID.get(b.building_id);
                  if (entry) {
                    for (const { tx, ty } of getFootprintTiles(b.tile_x, b.tile_y, entry.footprintW, entry.footprintH)) {
                      occupied.add(`${tx},${ty}`);
                    }
                  }
                }
                setOccupiedTiles(occupied);
              })
              .catch(() => {});
          }}
        />
      )}

      {/* Combat overlay */}
      {inCombat && cachedBuild.current && (
        <BattleOverlay
          playerBuild={cachedBuild.current}
          potions={potionCounts}
          onExit={(xp, coins, items) => {
            exitCombat(xp, coins, items);
          }}
          onPotionUsed={(type) => {
            if (type === 'healing_potion') {
              setPotionCounts(prev => ({ ...prev, healing: Math.max(0, prev.healing - 1) }));
            } else {
              setPotionCounts(prev => ({ ...prev, spirit: Math.max(0, prev.spirit - 1) }));
            }
          }}
        />
      )}

      {/* Inventory panel */}
      {showInventory && activeBuild && (
        <InventoryPanel
          onClose={() => setShowInventory(false)}
          coins={useAppStore.getState().phobosCoins}
          onCoinsChanged={setPhobosCoins}
          build={activeBuild}
          onBuildChanged={(updated) => {
            cachedBuild.current = updated;
            setActiveBuild(updated);
            // Also push updated skill state to combat controller if in world
            const game = gameRef.current;
            if (game) {
              const scene = game.scene.getScene('WorldScene') as WorldScene | null;
              if (scene?.combatController) scene.combatController.updateBuild(updated);
            }
          }}
          onEquipChanged={applyEquipmentToBuild}
        />
      )}

      {/* Shop panel */}
      {showShop && gameFocused && (
        <ShopPanel
          ether={ether}
          inventory={fullInventory}
          placedIds={placedBuildingIds}
          builtIds={builtBuildingIds}
          onClose={() => setShowShop(false)}
          onSpendEther={(amount) => {
            setEther(prev => prev - amount);
            fetch(`${ENGINE_URL}/api/game/ether/bank`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'withdraw', amount }),
            }).catch(() => {});
          }}
          onPurchase={(item, cost) => {
            setEther(prev => prev - cost);
            setFullInventory(prev => [...prev, item]);
            fetch(`${ENGINE_URL}/api/game/inventory/add`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ item_id: item.id, target: 'player', slot: item.slot, rarity: item.rarity, data: JSON.stringify(item) }),
            }).catch(() => {});
          }}
        />
      )}

      {/* Crafting menu */}
      {showCrafting && gameFocused && (
        <CraftingMenu
          inventory={fullInventory}
          ether={ether}
          onClose={() => setShowCrafting(false)}
          onCraft={(newItem, consumedIds) => {
            setFullInventory(prev => {
              const next = prev.filter(i => !consumedIds.includes(i.id));
              return [...next, newItem];
            });
            // Persist to backend
            fetch(`${ENGINE_URL}/api/game/inventory/add`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ item_id: newItem.id, target: 'player', slot: newItem.slot, rarity: newItem.rarity, data: JSON.stringify(newItem) }),
            }).catch(() => {});
          }}
        />
      )}

      {/* House panel */}
      {showHousePanel && (
        <HousePanel onClose={() => setShowHousePanel(false)} />
      )}

      {showParty && (
        <PartyPanel
          allies={allyStates as any}
          onRelease={(persona) => {
            const game = gameRef.current;
            if (!game) return;
            const scene = game.scene.getScene('WorldScene') as any;
            scene?.releaseAlly?.(persona);
          }}
          onClose={() => setShowParty(false)}
        />
      )}

      {/* Machine menu — generic or RCS based on menuType */}
      {activeMachineRec && gameFocused && (() => {
        const entry = MACHINE_BY_ID.get(activeMachineRec.buildingId);
        if (entry?.menuType === 'rcs' && activeMachineRec.state === 'built') {
          return (
            <RCSPanel
              record={activeMachineRec}
              engineUrl={ENGINE_URL}
              onClose={() => setActiveMachineRec(null)}
              onCollected={(materialId, units) => {
                const items = Array.from({ length: units }, (_, i) => ({
                  id: `rcs_${materialId}_${Date.now()}_${i}`,
                  type: 'crafting_material' as const,
                  name: materialId,
                  slot: null, rarity: 0 as RarityTier, quantity: 1, equipped: false,
                  tint: 0x888888,
                }));
                setFullInventory(prev => [...prev, ...items]);
              }}
              onConfigSaved={(recordId) => {
                const scene = gameRef.current?.scene.getScene('WorldScene') as WorldScene | null;
                scene?.loadPlayerBuildings?.();
              }}
            />
          );
        }
        return (
          <MachineMenuPanel
            record={activeMachineRec}
            inventory={fullInventory}
            ether={ether}
            engineUrl={ENGINE_URL}
            onClose={() => setActiveMachineRec(null)}
            onSupplied={(recordId) => {
              const scene = gameRef.current?.scene.getScene('WorldScene') as WorldScene | null;
              scene?.loadPlayerBuildings?.();
              // Re-fetch built set so FabShop and ShopPanel unlock gates update
              fetch(`${ENGINE_URL}/api/game/buildings`)
                .then(r => r.json() as Promise<Array<{ building_id: string; state: string }>>)
                .then(buildings => {
                  const built = new Set(buildings.filter(b => b.state === 'built').map(b => b.building_id));
                  setBuiltBuildingIds(built);
                })
                .catch(() => {});
            }}
            onDismantled={(recordId) => {
              setPlacedBuildingIds(prev => {
                // We don't know building_id here without a lookup — trigger full re-fetch
                return prev;
              });
              const scene = gameRef.current?.scene.getScene('WorldScene') as WorldScene | null;
              scene?.loadPlayerBuildings?.();
              // Re-fetch all sets
              fetch(`${ENGINE_URL}/api/game/buildings`)
                .then(r => r.json() as Promise<Array<{ building_id: string; tile_x: number; tile_y: number; state: string }>>)
                .then(buildings => {
                  const occupied  = new Set<string>();
                  const placed    = new Set<string>();
                  const built     = new Set<string>();
                  for (const b of buildings) {
                    placed.add(b.building_id);
                    if (b.state === 'built') built.add(b.building_id);
                    const e = MACHINE_BY_ID.get(b.building_id);
                    if (e) {
                      for (const { tx, ty } of getFootprintTiles(b.tile_x, b.tile_y, e.footprintW, e.footprintH)) {
                        occupied.add(`${tx},${ty}`);
                      }
                    }
                  }
                  setOccupiedTiles(occupied);
                  setPlacedBuildingIds(placed);
                  setBuiltBuildingIds(built);
                })
                .catch(() => {});
            }}
            onRelocate={(recordId, buildingId, label) => {
              setActiveMachineRec(null);
              // Unregister old footprint in Phaser before starting relocate
              const scene = gameRef.current?.scene.getScene('WorldScene') as WorldScene | null;
              scene?.unregisterBlockedFootprint?.(recordId);
              BuildingPlacementOverlay.relocate(buildingId, label, recordId);
            }}
          />
        );
      })()}

      {/* Frictionless Fab shop */}
      {showFabShop && gameFocused && (
        <FabShopPanel
          ether={ether}
          builtIds={builtBuildingIds}
          placedIds={placedBuildingIds}
          onClose={() => setShowFabShop(false)}
          onSpendEther={(amount) => {
            setEther(prev => prev - amount);
            fetch(`${ENGINE_URL}/api/game/ether/bank`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'withdraw', amount }),
            }).catch(() => {});
          }}
        />
      )}

      {/* Dev inventory panel */}
      {showDevPanel && (
        <DevInventoryPanel
          engineUrl={ENGINE_URL}
          onClose={() => setShowDevPanel(false)}
          onEtherAdded={(amount) => setEther(prev => prev + amount)}
          onItemAdded={(materialId, quantity) => {
            const items = Array.from({ length: quantity }, (_, i) => ({
              id: `dev_${materialId}_${Date.now()}_${i}`,
              type: 'crafting_material' as const,
              name: materialId,
              slot: null, rarity: 0 as RarityTier, quantity: 1, equipped: false,
              tint: 0x888888,
            }));
            setFullInventory(prev => [...prev, ...items]);
          }}
        />
      )}

      {/* Ally HUD — top right, visible in world mode */}
      {gameFocused && (
        <AllyHUD
          visible={true}
          allies={allyStates as any}
          onModeChange={(persona, mode) => {
            const game = gameRef.current;
            if (!game) return;
            const scene = game.scene.getScene('WorldScene') as any;
            scene?.setAllyMode?.(persona, mode);
            setAllyStates(prev => ({
              ...prev,
              [persona]: { ...prev[persona]!, mode } as AllyState,
            }));
          }}
        />
      )}

      {/* Game HUD — visible in world mode with character */}
      {gameFocused && cachedBuild.current && (
        <GameHUD
          visible={true}
          build={cachedBuild.current}
          hp={hudHp}
          maxHp={hudMaxHp}
          spirit={hudSpirit}
          maxSpirit={hudMaxSpirit}
          xp={cachedBuild.current.xp}
          xpToNext={Math.floor(100 * Math.pow(1.4, cachedBuild.current.level - 1))}
          level={cachedBuild.current.level}
          abilityCooldowns={hudCooldowns}
          combatMode={hudCombatMode}
          chargeProgress={hudChargeProgress}
          isReady={hudIsReady}
        />
      )}
    </>
  );
}
