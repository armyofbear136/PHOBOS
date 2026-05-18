/**
 * KeybindManager — Centralized keybind registry with remapping support.
 *
 * All game actions are looked up through this manager. PhobosGame.tsx reads
 * the current bindings to populate the settings panel. PlayerCombatController
 * calls isActionDown() / isActionJustDown() rather than raw key checks.
 *
 * Keybinds are persisted to localStorage. If no stored bindings exist the
 * defaults below are used.
 *
 * Action names are stable string keys. Phaser KeyCodes are used internally.
 */

import * as Phaser from 'phaser';

export type GameAction =
  | 'move_up' | 'move_down' | 'move_left' | 'move_right'
  | 'melee_mode'    // Q
  | 'ranged_mode'   // E
  | 'interact'      // R
  | 'roll'          // Shift
  | 'jump'          // Space
  | 'ready'         // Alt — hold to enter reduced-speed ready stance
  | 'ability_1'     // 1
  | 'ability_2'     // 2
  | 'ability_3'     // 3
  | 'inventory'     // I
  | 'map'           // M
  | 'party'         // P
  | 'world_toggle'; // `

export const ACTION_LABELS: Record<GameAction, string> = {
  move_up:      'Move Up',
  move_down:    'Move Down',
  move_left:    'Move Left',
  move_right:   'Move Right',
  melee_mode:   'Melee Mode',
  ranged_mode:  'Ranged Mode',
  interact:     'Interact',
  roll:         'Roll / Dodge',
  jump:         'Jump',
  ready:        'Ready Stance',
  ability_1:    'Ability 1',
  ability_2:    'Ability 2',
  ability_3:    'Ability 3',
  inventory:    'Inventory',
  map:          'Map',
  party:        'Party',
  world_toggle: 'World Toggle',
};

export const DEFAULT_BINDS: Record<GameAction, number> = {
  move_up:      Phaser.Input.Keyboard.KeyCodes.W,
  move_down:    Phaser.Input.Keyboard.KeyCodes.S,
  move_left:    Phaser.Input.Keyboard.KeyCodes.A,
  move_right:   Phaser.Input.Keyboard.KeyCodes.D,
  melee_mode:   Phaser.Input.Keyboard.KeyCodes.Q,
  ranged_mode:  Phaser.Input.Keyboard.KeyCodes.E,
  interact:     Phaser.Input.Keyboard.KeyCodes.R,
  roll:         Phaser.Input.Keyboard.KeyCodes.SHIFT,
  jump:         Phaser.Input.Keyboard.KeyCodes.SPACE,
  ready:        Phaser.Input.Keyboard.KeyCodes.ALT,
  ability_1:    Phaser.Input.Keyboard.KeyCodes.ONE,
  ability_2:    Phaser.Input.Keyboard.KeyCodes.TWO,
  ability_3:    Phaser.Input.Keyboard.KeyCodes.THREE,
  inventory:    Phaser.Input.Keyboard.KeyCodes.I,
  map:          Phaser.Input.Keyboard.KeyCodes.M,
  party:        Phaser.Input.Keyboard.KeyCodes.P,
  world_toggle: Phaser.Input.Keyboard.KeyCodes.BACKTICK,
};

const STORAGE_KEY = 'phobos_keybinds';

export class KeybindManager {
  private static _inst: KeybindManager | null = null;
  static getInstance(): KeybindManager {
    if (!KeybindManager._inst) KeybindManager._inst = new KeybindManager();
    return KeybindManager._inst;
  }

  private _binds: Record<GameAction, number> = { ...DEFAULT_BINDS };
  private _keys:  Partial<Record<GameAction, Phaser.Input.Keyboard.Key>> = {};
  private _scene: Phaser.Scene | null = null;

  private constructor() {
    this._loadFromStorage();
  }

  /** Call once in WorldScene.create() to register all keys with Phaser. */
  init(scene: Phaser.Scene): void {
    this._scene = scene;
    this._keys = {};
    const kb = scene.input.keyboard;
    if (!kb) return;
    for (const action of Object.keys(this._binds) as GameAction[]) {
      this._keys[action] = kb.addKey(this._binds[action], false);
    }
  }

  /** Remap an action to a new key code. Persists to localStorage. */
  remap(action: GameAction, keyCode: number): void {
    // Remove conflict with any other action
    for (const [a, code] of Object.entries(this._binds) as [GameAction, number][]) {
      if (code === keyCode && a !== action) {
        this._binds[a] = DEFAULT_BINDS[a]; // reset conflicting action to default
      }
    }
    this._binds[action] = keyCode;
    this._saveToStorage();

    // Re-register with Phaser if scene is available
    if (this._scene?.input.keyboard) {
      const kb = this._scene.input.keyboard;
      if (this._keys[action]) {
        kb.removeKey(this._keys[action]!);
      }
      this._keys[action] = kb.addKey(keyCode, false);
    }
  }

  resetToDefaults(): void {
    this._binds = { ...DEFAULT_BINDS };
    this._saveToStorage();
    if (this._scene) this.init(this._scene);
  }

  isDown(action: GameAction): boolean {
    return this._keys[action]?.isDown ?? false;
  }

  isJustDown(action: GameAction): boolean {
    const k = this._keys[action];
    return k ? Phaser.Input.Keyboard.JustDown(k) : false;
  }

  getKeyCode(action: GameAction): number { return this._binds[action]; }
  getKeyName(action: GameAction): string  { return this._keyCodeToName(this._binds[action]); }
  getAllBinds(): Record<GameAction, number> { return { ...this._binds }; }

  private _keyCodeToName(code: number): string {
    // Reverse-lookup Phaser KeyCodes
    const entry = Object.entries(Phaser.Input.Keyboard.KeyCodes).find(([, v]) => v === code);
    if (!entry) return `Key(${code})`;
    const name = entry[0];
    if (name === 'BACKTICK') return '`';
    if (name === 'SHIFT') return 'Shift';
    if (name === 'SPACE') return 'Space';
    if (name === 'ALT') return 'Alt';
    if (['ONE','TWO','THREE','FOUR','FIVE','SIX','SEVEN','EIGHT','NINE','ZERO'].includes(name)) {
      return name.charAt(0);
    }
    return name.length === 1 ? name : name.charAt(0) + name.slice(1).toLowerCase();
  }

  private _saveToStorage(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this._binds)); } catch { /* no-op */ }
  }

  private _loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Record<GameAction, number>>;
        for (const [a, v] of Object.entries(parsed) as [GameAction, number][]) {
          if (a in DEFAULT_BINDS) this._binds[a] = v;
        }
      }
    } catch { /* corrupt data — use defaults */ }
  }
}
