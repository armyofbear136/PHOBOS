import { PluginWorker }              from './PluginWorker';
import { PluginRegistry }            from './PluginRegistry';
import { GaussianBlurEffect }        from './effects/GaussianBlurEffect';
import { SharpenClassicEffect }      from './effects/SharpenClassicEffect';
import { EdgeDetectClassicEffect }   from './effects/EdgeDetectClassicEffect';
import { BrightnessContrastEffect }  from './effects/BrightnessContrastEffect';
import { HueSaturationEffect }       from './effects/HueSaturationEffect';
import { LevelsEffect }              from './effects/LevelsEffect';
import { CurvesEffect }              from './effects/CurvesEffect';

// =============================================================================
// Plugin system bootstrap
//
// Exports two singletons: `registry` and `pluginWorker`.
// Called once at app startup (before any document is opened).
//
// Built-in effects are serialised to self-contained source strings and sent
// to the worker via registerBuiltin(). In production, the build tool handles
// this serialisation. During development we use the inline pattern below.
//
// The maxPixels value passed to built-in effect constructors is the worst-case
// document size. Phase 2 will read this from app config. For now: 8192 × 8192
// = 67 million pixels — the practical ceiling for browser canvas.
// =============================================================================

const MAX_PIXELS = 8192 * 8192;

// ---------------------------------------------------------------------------
// Singletons — created once, exported for use by the editor and UI
// ---------------------------------------------------------------------------

/**
 * The URL of the compiled worker bundle. In Vite this is resolved at
 * build time by the `?worker&url` query. In other bundlers, substitute
 * the appropriate worker URL mechanism.
 *
 * During development / test environments where a bundler is not running,
 * this path is used as-is. The worker file must be served at this path.
 */
const WORKER_URL = new URL('./PluginWorker.worker.ts', import.meta.url);

export const pluginWorker = new PluginWorker(WORKER_URL);
export const registry     = new PluginRegistry(pluginWorker);

// ---------------------------------------------------------------------------
// Built-in effect source serialisation helper
//
// Wraps an effect class into the self.__phobosEffect convention required by
// the worker. The class must be self-contained (no external imports) in the
// serialised form. Built-in effects are written to satisfy this constraint.
// ---------------------------------------------------------------------------

function serializeEffect(EffectClass: new (maxPixels: number) => object, maxPixels: number): string;
function serializeEffect(EffectClass: new () => object): string;
function serializeEffect(EffectClass: new (...args: number[]) => object, maxPixels?: number): string {
  // In a real build pipeline this would be a Rollup/Vite plugin that inlines
  // the class source. Here we use Function.prototype.toString() which returns
  // the source of the constructor for native classes in V8/SpiderMonkey.
  //
  // This approach works in development. Production builds must use the build
  // plugin to produce a static string.
  const args = maxPixels !== undefined ? String(maxPixels) : '';
  return `
    ${EffectClass.toString()}
    self.__phobosEffect = new ${EffectClass.name}(${args});
  `;
}

// ---------------------------------------------------------------------------
// Bootstrap — called once at startup
// ---------------------------------------------------------------------------

export async function initPlugins(): Promise<void> {
  await pluginWorker.ready;

  await registry.registerBuiltin(
    new GaussianBlurEffect(MAX_PIXELS).describe(),
    serializeEffect(GaussianBlurEffect, MAX_PIXELS),
  );

  await registry.registerBuiltin(
    new SharpenClassicEffect(MAX_PIXELS).describe(),
    serializeEffect(SharpenClassicEffect, MAX_PIXELS),
  );

  await registry.registerBuiltin(
    new EdgeDetectClassicEffect().describe(),
    serializeEffect(EdgeDetectClassicEffect),
  );

  await registry.registerBuiltin(
    new BrightnessContrastEffect().describe(),
    serializeEffect(BrightnessContrastEffect),
  );

  await registry.registerBuiltin(
    new HueSaturationEffect().describe(),
    serializeEffect(HueSaturationEffect),
  );

  await registry.registerBuiltin(
    new LevelsEffect().describe(),
    serializeEffect(LevelsEffect),
  );

  await registry.registerBuiltin(
    new CurvesEffect().describe(),
    serializeEffect(CurvesEffect),
  );
}
