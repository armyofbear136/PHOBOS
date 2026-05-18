/**
 * EnemyAI — Per-enemy behavior state machines for PHOBOS active combat.
 *
 * ARCHITECTURE
 * ─────────────
 * Each of the 21 enemy types gets a concrete subclass of EnemyAIBase.
 * All share the base state machine: idle → aggro → combat loop → dead.
 * Unique mechanics (phase strike, tether bond, singularity pull, etc.)
 * are implemented as overrides on _selectAction() and _onActionComplete().
 *
 * The combat loop drives from CombatState.pickEnemyAction(), which calls
 * enemy.selectAction(combatContext) and returns a CombatAction.
 *
 * ELEMENT GROUPINGS
 * ─────────────────
 *   Plasma  : GHAST (minion), JUSTICAR (warrior), MYSTIC (leader), APEX HERALD (boss)
 *   Fire    : CINDER (minion), FORGE KNIGHT (warrior), EMBER WITCH (leader), MOLTEN SOVEREIGN (boss)
 *   Ice     : SHARD (minion), PERMAFROST SENTINEL (warrior), GLACIAL WARDEN (leader), CRYOLITH (boss)
 *   Lightning: ARC (minion), VOLTBREAKER (warrior), STORM HERALD (leader), TEMPEST CORE (boss)
 *   Void    : WRAITH (minion), ENTROPY STALKER (warrior), VOID WEAVER (leader), NULL SOVEREIGN (boss)
 *
 * BOND MECHANICS (Minion ↔ Leader)
 * ──────────────────────────────────
 *   Each element's minion and leader share a bond mechanic.
 *   When the leader is alive and present in the same encounter, minions of that
 *   element receive a passive buff (speed, defense, or damage bonus).
 *   When the leader dies, the bond breaks — minions enter a brief frenzy.
 *
 * ACTION RETURN VALUES
 * ─────────────────────
 * selectAction() returns a CombatAction. Extended fields:
 *   type:        'melee' | 'ranged' | 'ability' | 'special'
 *   abilityIndex: 0 = primary ability, 1 = secondary, 2 = boss/ultimate
 *   Special abilities are resolved in CombatState.resolveAction() via
 *   the abilityName field on ActionResult.
 */

import type { EnemyTemplate, CombatAction, Combatant } from './CombatState';
import type { ElementType } from './PlayerClasses';

// ─── AI state ────────────────────────────────────────────────────────────

export type AIState =
  | 'idle'
  | 'aggro'          // just entered combat, plays aggro animation
  | 'approach'       // moving toward target
  | 'melee'          // executing a melee attack
  | 'ranged'         // executing a ranged attack
  | 'ability'        // casting primary ability
  | 'special'        // boss/unique special action
  | 'phase'          // phasing (WRAITH, ENTROPY STALKER)
  | 'cooldown'       // brief wait between actions
  | 'frenzy'         // post-bond-break burst
  | 'dead';

// ─── Combat context passed to selectAction ───────────────────────────────

export interface CombatContext {
  /** Alive party members with index */
  party:     Array<{ combatant: Combatant; index: number }>;
  /** All enemies in the encounter (for leader bond checks) */
  enemies:   Array<{ combatant: Combatant; index: number; ai: EnemyAIBase }>;
  /** Turn number */
  turn:      number;
  /** This enemy's own index in the enemies array */
  selfIndex: number;
}

// ─── Base class ───────────────────────────────────────────────────────────

export abstract class EnemyAIBase {
  // Identity
  readonly templateKey: string;
  readonly element:     ElementType;
  readonly archetype:   'minion' | 'warrior' | 'leader' | 'boss' | 'dummy';

  // World-space position (used by WorldScene active combat)
  x = 0;
  y = 0;

  // Combat state
  hp    = 0;
  maxHp = 0;
  state: AIState = 'idle';

  // Internal timers / counters — mutated in place, never reallocated
  protected _turn          = 0;   // turns taken
  protected _cooldown      = 0;   // turns remaining in cooldown
  protected _bondBroken    = false;
  protected _frenzyTurns   = 0;

  // Move-speed / range (pixels at 60fps)
  moveSpeed    = 1.2;
  attackRange  = 28;
  aggroRange   = 120;

  constructor(key: string, element: ElementType, archetype: EnemyAIBase['archetype']) {
    this.templateKey = key;
    this.element     = element;
    this.archetype   = archetype;
  }

  /** Main entry point — return the action to take this turn. */
  selectAction(ctx: CombatContext): CombatAction {
    if (this.state === 'dead') return this._idle(ctx);

    this._turn++;

    // Frenzy post-bond-break
    if (this._frenzyTurns > 0) {
      this._frenzyTurns--;
      return this._frenzyAction(ctx);
    }

    if (this._cooldown > 0) {
      this._cooldown--;
      return this._idle(ctx);
    }

    return this._selectAction(ctx);
  }

  /** Subclasses implement their specific action selection here. */
  protected abstract _selectAction(ctx: CombatContext): CombatAction;

  /** Called when the leader of this element dies (if this is a minion). */
  notifyBondBroken(): void {
    this._bondBroken = true;
    this._frenzyTurns = 2; // two turns of frenzy
  }

  /** Apply damage; returns true if killed. */
  takeDamage(amount: number): boolean {
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) { this.state = 'dead'; return true; }
    return false;
  }

  // ── Shared helpers ─────────────────────────────────────────────────────

  /** Pick the lowest-HP alive party member. */
  protected _weakestTarget(ctx: CombatContext): number {
    const alive = ctx.party.filter(p => !p.combatant.dead);
    if (!alive.length) return 0;
    return alive.reduce((a, b) => a.combatant.hp < b.combatant.hp ? a : b).index;
  }

  /** Pick a random alive party member. */
  protected _randomTarget(ctx: CombatContext): number {
    const alive = ctx.party.filter(p => !p.combatant.dead);
    if (!alive.length) return 0;
    return alive[Math.floor(Math.random() * alive.length)].index;
  }

  /** Does the leader of this element exist in the encounter and is alive? */
  protected _leaderAlive(ctx: CombatContext): boolean {
    return ctx.enemies.some(
      e => e.ai.element === this.element
        && e.ai.archetype === 'leader'
        && !e.combatant.dead
    );
  }

  protected _idle(ctx: CombatContext): CombatAction {
    return { type: 'melee', targetIndex: this._randomTarget(ctx) };
  }

  protected _frenzyAction(ctx: CombatContext): CombatAction {
    return { type: 'melee', targetIndex: this._weakestTarget(ctx) };
  }

  protected _melee(ctx: CombatContext): CombatAction {
    return { type: 'melee', targetIndex: this._weakestTarget(ctx) };
  }

  protected _ranged(ctx: CombatContext): CombatAction {
    return { type: 'ranged', targetIndex: this._weakestTarget(ctx) };
  }

  protected _ability(abilityIndex: number, ctx: CombatContext): CombatAction {
    return { type: 'ability', abilityIndex, targetIndex: this._weakestTarget(ctx) };
  }

  protected _special(ctx: CombatContext): CombatAction {
    return { type: 'ability', abilityIndex: 2, targetIndex: this._randomTarget(ctx) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PLASMA ENEMIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GHAST — Plasma Minion
 * Bond: Leader (MYSTIC) alive → +15% damage
 * Mechanic: V-Beam Convergence — every 4th turn, channels a telegraphed
 *   ranged ability that deals high damage and applies Exposure status.
 *   Charges for 1 turn (skips action), fires on the next.
 */
export class GhastAI extends EnemyAIBase {
  private _chargeCounter = 0;
  private _charged = false;

  constructor() { super('ghast', 'plasma', 'minion'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    this._chargeCounter++;

    // Charging: skip this turn (wait), fire next
    if (this._charged) {
      this._charged = false;
      this._cooldown = 1;
      return { type: 'ability', abilityIndex: 0, targetIndex: this._weakestTarget(ctx),
               // abilityName resolved in CombatState as 'v_beam'
             };
    }

    // Every 4th turn: begin charging V-Beam
    if (this._chargeCounter % 4 === 0) {
      this._charged = true;
      return this._idle(ctx); // charge turn — do nothing damaging
    }

    return this._melee(ctx);
  }

  protected override _frenzyAction(ctx: CombatContext): CombatAction {
    // Bond-broken frenzy: fire V-Beam immediately without charge
    return { type: 'ability', abilityIndex: 0, targetIndex: this._weakestTarget(ctx) };
  }
}

/**
 * JUSTICAR — Plasma Warrior
 * Mechanic: Sentinel Stance — every 3rd turn, enters a defensive stance that
 *   reduces incoming damage by 40% for 1 turn (handled in CombatState via
 *   abilityName 'sentinel_stance').
 *   On even turns: melee. On odd turns: ranged plasma bolt.
 */
export class JusticarAI extends EnemyAIBase {
  constructor() { super('justicar', 'plasma', 'warrior'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    if (this._turn % 3 === 0) {
      return { type: 'ability', abilityIndex: 0, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'sentinel_stance'
    }
    return this._turn % 2 === 0 ? this._melee(ctx) : this._ranged(ctx);
  }
}

/**
 * MYSTIC — Plasma Leader
 * Bond mechanic: while alive, all GHAST in encounter get +15% damage.
 * Mechanic: Plasma Aegis — ability0: places a 20-HP shield on itself.
 *           Plasma Burst — ability1: AoE ranged that hits all party members.
 * Pattern: 2× melee → aegis → ranged → ranged → burst → repeat.
 */
export class MysticAI extends EnemyAIBase {
  private _seq = 0;

  constructor() { super('mystic', 'plasma', 'leader'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    this._seq = (this._seq + 1) % 6;
    switch (this._seq) {
      case 0: case 1: return this._melee(ctx);
      case 2: return { type: 'ability', abilityIndex: 0, targetIndex: this._randomTarget(ctx) }; // aegis
      case 3: case 4: return this._ranged(ctx);
      case 5: return { type: 'ability', abilityIndex: 1, targetIndex: this._randomTarget(ctx) }; // burst AoE
      default: return this._melee(ctx);
    }
  }
}

/**
 * APEX HERALD — Plasma Boss
 * Phase 1 (>50% HP): Standard plasma attacks + Judgment Beam (ability0) every 5 turns.
 * Phase 2 (<50% HP): Adds Herald's Cascade (ability1) — AoE plasma every 3 turns.
 * Ultimate: Phase 2 turn 1 → ability2 'herald_surge' — full team hit + self-heal.
 * Special: Judgment Beam telegraphs 1 turn before firing (same as GHAST).
 */
export class ApexHeraldAI extends EnemyAIBase {
  private _phase2Triggered = false;
  private _beamCharged     = false;
  private _phase2Turn      = 0;

  constructor() { super('apex_herald', 'plasma', 'boss'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    // Phase 2 transition
    const hpPct = this.hp / this.maxHp;
    if (hpPct < 0.5 && !this._phase2Triggered) {
      this._phase2Triggered = true;
      this._phase2Turn = 0;
      return { type: 'ability', abilityIndex: 2, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'herald_surge' — AoE + self-heal
    }

    if (this._phase2Triggered) this._phase2Turn++;

    // Beam charge/fire cycle
    if (this._beamCharged) {
      this._beamCharged = false;
      this._cooldown = 1;
      return { type: 'ability', abilityIndex: 0, targetIndex: this._weakestTarget(ctx) };
      // abilityName: 'judgment_beam'
    }
    if (this._turn % 5 === 0) {
      this._beamCharged = true;
      return this._idle(ctx);
    }

    // Phase 2 cascade
    if (this._phase2Triggered && this._phase2Turn % 3 === 0) {
      return { type: 'ability', abilityIndex: 1, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'heralds_cascade'
    }

    return this._turn % 2 === 0 ? this._melee(ctx) : this._ranged(ctx);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FIRE ENEMIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * CINDER — Fire Minion
 * Bond: EMBER WITCH alive → +20% damage, embers leave Burn on hit.
 * Mechanic: Ember Burst — every 3rd turn, ranged ability that applies Burn.
 *   Otherwise: melee, melee, ember.
 */
export class CinderAI extends EnemyAIBase {
  constructor() { super('cinder', 'fire', 'minion'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    if (this._turn % 3 === 0) {
      return { type: 'ability', abilityIndex: 0, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'ember_burst' → Burn status
    }
    return this._melee(ctx);
  }
}

/**
 * FORGE KNIGHT — Fire Warrior
 * Mechanic: Molten Armor — passive: reflects 3 damage on every melee hit received.
 *   (handled in CombatState damage resolution)
 *   Forge Slam — ability0: heavy melee + ground fire patch under target.
 *   Pattern: 2× melee → forge_slam → repeat.
 */
export class ForgeKnightAI extends EnemyAIBase {
  constructor() { super('forge_knight', 'fire', 'warrior'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    if (this._turn % 3 === 2) {
      return { type: 'ability', abilityIndex: 0, targetIndex: this._weakestTarget(ctx) };
      // abilityName: 'forge_slam' → heavy melee + fire_patch hazard
    }
    return this._melee(ctx);
  }
}

/**
 * EMBER WITCH — Fire Leader
 * Bond: CINDER in encounter → +20% damage, Burn on every hit.
 * Mechanic: Hex Flame — ability0: single target high damage + Burn.
 *           Conflagration — ability1: AoE fire damage all party.
 * Pattern: ranged → ranged → hex → ranged → conflagration → repeat.
 */
export class EmberWitchAI extends EnemyAIBase {
  private _seq = 0;

  constructor() { super('ember_witch', 'fire', 'leader'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    this._seq = (this._seq + 1) % 5;
    switch (this._seq) {
      case 0: case 1: case 3: return this._ranged(ctx);
      case 2: return { type: 'ability', abilityIndex: 0, targetIndex: this._weakestTarget(ctx) }; // hex_flame
      case 4: return { type: 'ability', abilityIndex: 1, targetIndex: this._randomTarget(ctx) };  // conflagration
      default: return this._ranged(ctx);
    }
  }
}

/**
 * MOLTEN SOVEREIGN — Fire Boss
 * Phase 1: Lava Crush (ability0, melee AoE shockwave) every 4 turns.
 * Phase 2 (<50%): Eruption (ability1) every 3 turns — AoE fire damage all + fire patches.
 * Special: at 25% HP triggers Magma Form (ability2) — next 3 attacks deal 2× damage.
 */
export class MoltenSovereignAI extends EnemyAIBase {
  private _phase2Active   = false;
  private _magmaFormUsed  = false;
  private _magmaFormTurns = 0;

  constructor() { super('molten_sovereign', 'fire', 'boss'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    const hpPct = this.hp / this.maxHp;

    // 25% HP: Magma Form (once only)
    if (hpPct < 0.25 && !this._magmaFormUsed) {
      this._magmaFormUsed = true;
      this._magmaFormTurns = 3;
      return { type: 'ability', abilityIndex: 2, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'magma_form'
    }

    // Phase 2 transition
    if (hpPct < 0.5 && !this._phase2Active) {
      this._phase2Active = true;
    }

    // Eruption in phase 2
    if (this._phase2Active && this._turn % 3 === 0) {
      return { type: 'ability', abilityIndex: 1, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'eruption'
    }

    // Lava Crush
    if (this._turn % 4 === 0) {
      return { type: 'ability', abilityIndex: 0, targetIndex: this._weakestTarget(ctx) };
      // abilityName: 'lava_crush'
    }

    return this._melee(ctx);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ICE ENEMIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * SHARD — Ice Minion
 * Bond: GLACIAL WARDEN alive → +10% defense, Slow on hit.
 * Mechanic: Ice Shatter — ability0: ranged ability that applies Slow.
 *   Pattern: melee, melee, ice_shatter, repeat.
 */
export class ShardAI extends EnemyAIBase {
  constructor() { super('shard', 'ice', 'minion'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    if (this._turn % 3 === 2) {
      return { type: 'ability', abilityIndex: 0, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'ice_shatter' → Slow status
    }
    return this._melee(ctx);
  }
}

/**
 * PERMAFROST SENTINEL — Ice Warrior
 * Mechanic: Glacial Shield — ability0 (self): blocks next hit entirely (once per 5 turns).
 *   Frost Cleave — melee that Slows on hit.
 *   Pattern: frost_cleave × 2 → glacial_shield → frost_cleave × 2 → repeat.
 */
export class PermafrostSentinelAI extends EnemyAIBase {
  private _shieldCooldown = 0;

  constructor() { super('permafrost_sentinel', 'ice', 'warrior'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    if (this._shieldCooldown > 0) this._shieldCooldown--;

    if (this._shieldCooldown === 0 && this._turn % 5 === 3) {
      this._shieldCooldown = 5;
      return { type: 'ability', abilityIndex: 0, targetIndex: 0 }; // self-cast shield
      // abilityName: 'glacial_shield'
    }
    return { type: 'melee', targetIndex: this._weakestTarget(ctx) };
    // melee hits also apply Slow in CombatState for this enemy
  }
}

/**
 * GLACIAL WARDEN — Ice Leader
 * Bond: SHARD in encounter → +10% defense, Slow on hit for all SHARD.
 * Mechanic: Frost Nova — ability0: AoE Slow all party.
 *           Ice Prison — ability1: single target Stun for 2 turns.
 * Pattern: ranged × 2 → frost_nova → melee → ice_prison → repeat.
 */
export class GlacialWardenAI extends EnemyAIBase {
  private _seq = 0;

  constructor() { super('glacial_warden', 'ice', 'leader'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    this._seq = (this._seq + 1) % 5;
    switch (this._seq) {
      case 0: case 1: return this._ranged(ctx);
      case 2: return { type: 'ability', abilityIndex: 0, targetIndex: this._randomTarget(ctx) }; // frost_nova
      case 3: return this._melee(ctx);
      case 4: return { type: 'ability', abilityIndex: 1, targetIndex: this._weakestTarget(ctx) }; // ice_prison
      default: return this._ranged(ctx);
    }
  }
}

/**
 * CRYOLITH — Ice Boss
 * Phase 1: Crystalline Burst (ability0) every 3 turns — ranged AoE + frost_patch.
 * Phase 2 (<60%): Absolute Zero (ability1) every 4 turns — massive AoE Slow + Stun.
 * Ultimate at 30%: Glacial Convergence (ability2) — pull all party to boss + AoE Stun.
 */
export class CryolithAI extends EnemyAIBase {
  private _phase2Active = false;
  private _ultimateUsed = false;

  constructor() { super('cryolith', 'ice', 'boss'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    const hpPct = this.hp / this.maxHp;

    if (hpPct < 0.30 && !this._ultimateUsed) {
      this._ultimateUsed = true;
      return { type: 'ability', abilityIndex: 2, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'glacial_convergence'
    }

    if (hpPct < 0.60 && !this._phase2Active) this._phase2Active = true;

    if (this._phase2Active && this._turn % 4 === 0) {
      return { type: 'ability', abilityIndex: 1, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'absolute_zero'
    }

    if (this._turn % 3 === 0) {
      return { type: 'ability', abilityIndex: 0, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'crystalline_burst'
    }

    return this._turn % 2 === 0 ? this._melee(ctx) : this._ranged(ctx);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LIGHTNING ENEMIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ARC — Lightning Minion
 * Bond: STORM HERALD alive → +25% attack speed (reflected in action frequency).
 * Mechanic: Chain Bolt — ability0: ranged that chains to an additional target.
 *   Pattern: melee, chain_bolt, chain_bolt, melee, repeat.
 */
export class ArcAI extends EnemyAIBase {
  constructor() { super('arc', 'lightning', 'minion'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    if (this._turn % 4 === 1 || this._turn % 4 === 2) {
      return { type: 'ability', abilityIndex: 0, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'chain_bolt'
    }
    return this._melee(ctx);
  }
}

/**
 * VOLTBREAKER — Lightning Warrior
 * Mechanic: Overcharge — ability0 (self): next attack deals 2× damage + stuns.
 *   Lightning Surge — ability1: heavy ranged single target.
 *   Pattern: surge → surge → overcharge → (charged) surge → repeat.
 */
export class VoltbreakerAI extends EnemyAIBase {
  private _overcharged = false;

  constructor() { super('voltbreaker', 'lightning', 'warrior'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    if (this._overcharged) {
      this._overcharged = false;
      return { type: 'ability', abilityIndex: 1, targetIndex: this._weakestTarget(ctx) };
      // abilityName: 'lightning_surge_charged' — 2× damage + stun
    }
    if (this._turn % 4 === 2) {
      this._overcharged = true;
      return { type: 'ability', abilityIndex: 0, targetIndex: 0 }; // self-cast
      // abilityName: 'overcharge'
    }
    return { type: 'ability', abilityIndex: 1, targetIndex: this._weakestTarget(ctx) };
    // abilityName: 'lightning_surge'
  }
}

/**
 * STORM HERALD — Lightning Leader
 * Bond: ARC in encounter → +25% attack speed for all ARC.
 * Mechanic: Static Field — ability0: passive applied at combat start, ticks
 *   1 lightning damage per turn to all party (handled each turn in CombatState).
 *   Thunderclap — ability1: AoE stun 1 turn all party.
 *   Pattern: ranged × 3 → thunderclap → repeat. Static field always active.
 */
export class StormHeraldAI extends EnemyAIBase {
  private _seq = 0;

  constructor() { super('storm_herald', 'lightning', 'leader'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    this._seq = (this._seq + 1) % 4;
    if (this._seq === 3) {
      return { type: 'ability', abilityIndex: 1, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'thunderclap'
    }
    return this._ranged(ctx);
  }
}

/**
 * TEMPEST CORE — Lightning Boss
 * Passive: Static Discharge — every turn, 2 lightning damage to entire party (field effect).
 * Phase 1: Chain Discharge (ability0) every 3 turns — chains through party members.
 * Phase 2 (<50%): Overload state (ability1) — charges 1 turn then screen-wide discharge.
 *   During overload charge: skip damage turn (just charges).
 * Ultimate at 25%: Conductor Rod Supercharge (ability2) — 5-second Overload, 
 *   doubles all damage during window.
 */
export class TempestCoreAI extends EnemyAIBase {
  private _phase2Active   = false;
  private _overloading    = false;
  private _ultimateUsed   = false;

  constructor() { super('tempest_core', 'lightning', 'boss'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    const hpPct = this.hp / this.maxHp;

    if (hpPct < 0.25 && !this._ultimateUsed) {
      this._ultimateUsed = true;
      return { type: 'ability', abilityIndex: 2, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'conductor_supercharge'
    }

    if (hpPct < 0.5 && !this._phase2Active) this._phase2Active = true;

    // Overload charge/fire cycle
    if (this._overloading) {
      this._overloading = false;
      this._cooldown = 2;
      return { type: 'ability', abilityIndex: 1, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'overload_discharge'
    }
    if (this._phase2Active && this._turn % 4 === 3) {
      this._overloading = true;
      return this._idle(ctx); // charge turn
    }

    if (this._turn % 3 === 0) {
      return { type: 'ability', abilityIndex: 0, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'chain_discharge'
    }

    return this._turn % 2 === 0 ? this._melee(ctx) : this._ranged(ctx);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VOID ENEMIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * WRAITH — Void Minion
 * Bond: VOID WEAVER alive → WRAITH is tethered, gains +20% dodge chance.
 *   When tether is active, death of WRAITH refunds a portion of WEAVER's HP.
 * Mechanic: Phase Strike — ability0: becomes near-invisible for 1 turn,
 *   then reappears and strikes. High damage, can't be blocked.
 *   Void Pull — ability1: ranged that pulls the target (reduces target defense 2 turns).
 *   Drain Touch — ability2: melee that steals HP (heals WRAITH).
 *   Pattern: melee × 2 → phase_strike → void_pull → drain_touch → repeat.
 */
export class WraithAI extends EnemyAIBase {
  private _seq         = 0;
  private _phaseActive = false;
  private _tethered    = false;

  constructor() { super('wraith', 'void', 'minion'); }

  /** Called by VOID WEAVER when tether is established. */
  setTethered(active: boolean): void { this._tethered = active; }
  get isTethered(): boolean { return this._tethered; }

  protected _selectAction(ctx: CombatContext): CombatAction {
    this._seq = (this._seq + 1) % 5;

    if (this._phaseActive) {
      this._phaseActive = false;
      // Phase resolves: high-damage unblockable strike
      return { type: 'ability', abilityIndex: 0, targetIndex: this._weakestTarget(ctx) };
      // abilityName: 'phase_strike_resolve'
    }

    switch (this._seq) {
      case 0: case 1: return this._melee(ctx);
      case 2:
        this._phaseActive = true;
        return this._idle(ctx); // phase-out turn (no damage yet)
      case 3:
        return { type: 'ability', abilityIndex: 1, targetIndex: this._randomTarget(ctx) };
        // abilityName: 'void_pull'
      case 4:
        return { type: 'ability', abilityIndex: 2, targetIndex: this._weakestTarget(ctx) };
        // abilityName: 'drain_touch'
      default:
        return this._melee(ctx);
    }
  }

  protected override _frenzyAction(ctx: CombatContext): CombatAction {
    // Post-bond-break: phase strike immediately
    this._phaseActive = false;
    return { type: 'ability', abilityIndex: 0, targetIndex: this._weakestTarget(ctx) };
  }
}

/**
 * ENTROPY STALKER — Void Warrior
 * Mechanic: Shadow Step — ability0 (self): teleport behind target, next melee
 *   is guaranteed crit (unblockable from behind).
 *   Entropy Surge — ability1: ranged that applies Entropy status (stacks, each
 *   stack reduces all stats by 3%).
 *   Void Bolt — ranged basic attack.
 *   Pattern: void_bolt × 2 → shadow_step → (crit melee) → entropy_surge → repeat.
 */
export class EntropyStalkerAI extends EnemyAIBase {
  private _shadowStepped = false;
  private _seq           = 0;

  constructor() { super('entropy_stalker', 'void', 'warrior'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    if (this._shadowStepped) {
      this._shadowStepped = false;
      return { type: 'melee', targetIndex: this._weakestTarget(ctx) };
      // CombatState flags: guaranteed_crit = true for this action
    }

    this._seq = (this._seq + 1) % 5;
    switch (this._seq) {
      case 0: case 1: return this._ranged(ctx); // void_bolt
      case 2:
        this._shadowStepped = true;
        return { type: 'ability', abilityIndex: 0, targetIndex: 0 }; // shadow_step self
      case 4:
        return { type: 'ability', abilityIndex: 1, targetIndex: this._randomTarget(ctx) };
        // abilityName: 'entropy_surge'
      default:
        return this._ranged(ctx);
    }
  }
}

/**
 * VOID WEAVER — Void Leader
 * Bond: manages tethers to all WRAITH in encounter.
 *   On combat start: tethers all WRAITH (calls setTethered(true)).
 *   On re-tether (ability0): restores tether to a dead WRAITH if any survive.
 * Mechanic: Void Tether Cast — ability0: establishes/restores tethers.
 *           Void Bolt — ranged basic.
 *           Dark Pull — ability1: pulls all party toward WEAVER (reduces their evasion).
 * Pattern: bolt × 2 → tether_cast → bolt × 2 → dark_pull → repeat.
 */
export class VoidWeaverAI extends EnemyAIBase {
  private _seq = 0;

  constructor() { super('void_weaver', 'void', 'leader'); }

  /** Initialize tethers at combat start — caller passes wraith AIs */
  initTethers(wraiths: WraithAI[]): void {
    for (const w of wraiths) w.setTethered(true);
  }

  protected _selectAction(ctx: CombatContext): CombatAction {
    this._seq = (this._seq + 1) % 6;
    switch (this._seq) {
      case 0: case 1: return this._ranged(ctx);
      case 2:
        return { type: 'ability', abilityIndex: 0, targetIndex: this._randomTarget(ctx) };
        // abilityName: 'void_tether_cast'
      case 3: case 4: return this._ranged(ctx);
      case 5:
        return { type: 'ability', abilityIndex: 1, targetIndex: this._randomTarget(ctx) };
        // abilityName: 'dark_pull'
      default: return this._ranged(ctx);
    }
  }
}

/**
 * NULL SOVEREIGN — Void Boss
 * Passive: Entropy Accumulator — each turn, +1 Entropy stack on a random party member.
 * Phase 1: Tendril Strike (ability0) — melee multi-hit. Void Bolt Barrage (ability1) — ranged AoE.
 * Phase 2 (<50%): Void Collapse (ability2) — arena-wide pull to boss center + AoE + Entropy stacks.
 *   Triggered once, then available every 6 turns.
 * Ultimate at 20%: Singularity Activation — 3 turns of massive pull + AoE each turn.
 */
export class NullSovereignAI extends EnemyAIBase {
  private _phase2Triggered  = false;
  private _collapseRecharge = 0;
  private _singularityActive = false;
  private _singularityTurns  = 0;

  constructor() { super('null_sovereign', 'void', 'boss'); }

  protected _selectAction(ctx: CombatContext): CombatAction {
    const hpPct = this.hp / this.maxHp;

    // Singularity activation at 20%
    if (hpPct < 0.20 && !this._singularityActive && !this._phase2Triggered) {
      this._singularityActive = true;
      this._singularityTurns  = 3;
    }
    if (this._singularityActive && this._singularityTurns > 0) {
      this._singularityTurns--;
      return { type: 'ability', abilityIndex: 2, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'singularity_pull_tick'
    }
    if (this._singularityActive && this._singularityTurns === 0) {
      this._singularityActive = false;
    }

    // Phase 2 transition / Void Collapse
    if (this._collapseRecharge > 0) this._collapseRecharge--;
    if (!this._phase2Triggered && hpPct < 0.50) {
      this._phase2Triggered  = true;
      this._collapseRecharge = 6;
      return { type: 'ability', abilityIndex: 2, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'void_collapse'
    }
    if (this._phase2Triggered && this._collapseRecharge === 0) {
      this._collapseRecharge = 6;
      return { type: 'ability', abilityIndex: 2, targetIndex: this._randomTarget(ctx) };
    }

    // Normal rotation
    if (this._turn % 3 === 0) {
      return { type: 'ability', abilityIndex: 1, targetIndex: this._randomTarget(ctx) };
      // abilityName: 'void_barrage'
    }
    if (this._turn % 3 === 1) {
      return { type: 'ability', abilityIndex: 0, targetIndex: this._weakestTarget(ctx) };
      // abilityName: 'tendril_strike'
    }
    return this._melee(ctx);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TRAINING DUMMY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * TRAINING DUMMY — Practice Target
 * Never attacks. Just absorbs damage and resets when broken.
 */
export class TrainingDummyAI extends EnemyAIBase {
  constructor() { super('training_dummy', 'plasma', 'dummy'); }
  protected _selectAction(ctx: CombatContext): CombatAction {
    return this._idle(ctx); // never acts
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

export type EnemyAIClass = new () => EnemyAIBase;

export const ENEMY_AI_REGISTRY: Record<string, EnemyAIClass> = {
  training_dummy:       TrainingDummyAI,
  ghast:                GhastAI,
  justicar:             JusticarAI,
  mystic:               MysticAI,
  apex_herald:          ApexHeraldAI,
  cinder:               CinderAI,
  forge_knight:         ForgeKnightAI,
  ember_witch:          EmberWitchAI,
  molten_sovereign:     MoltenSovereignAI,
  shard:                ShardAI,
  permafrost_sentinel:  PermafrostSentinelAI,
  glacial_warden:       GlacialWardenAI,
  cryolith:             CryolithAI,
  arc:                  ArcAI,
  voltbreaker:          VoltbreakerAI,
  storm_herald:         StormHeraldAI,
  tempest_core:         TempestCoreAI,
  wraith:               WraithAI,
  entropy_stalker:      EntropyStalkerAI,
  void_weaver:          VoidWeaverAI,
  null_sovereign:       NullSovereignAI,
  // Legacy keys mapped to nearest equivalent
  moon_wraith:          WraithAI,
  crater_golem:         ForgeKnightAI,
  spark_wisp:           ArcAI,
  frost_sentinel:       PermafrostSentinelAI,
};

/** Instantiate and configure an EnemyAI from its template key. */
export function createEnemyAI(
  templateKey: string,
  maxHp: number,
  spawnX = 0,
  spawnY = 0
): EnemyAIBase {
  const Cls = ENEMY_AI_REGISTRY[templateKey] ?? TrainingDummyAI;
  const ai  = new Cls();
  ai.maxHp  = maxHp;
  ai.hp     = maxHp;
  ai.x      = spawnX;
  ai.y      = spawnY;
  return ai;
}

/** Wire bond mechanics after all enemies in an encounter are created. */
export function wireBondMechanics(enemies: Array<{ key: string; ai: EnemyAIBase }>): void {
  // Find VOID WEAVER and wire tethers to all WRAITHs
  const weaver = enemies.find(e => e.ai instanceof VoidWeaverAI)?.ai as VoidWeaverAI | undefined;
  if (weaver) {
    const wraiths = enemies
      .filter(e => e.ai instanceof WraithAI)
      .map(e => e.ai as WraithAI);
    weaver.initTethers(wraiths);
  }
  // Other bond mechanics (leader-minion buff) are checked dynamically
  // in selectAction() via _leaderAlive() each turn — no setup needed.
}
