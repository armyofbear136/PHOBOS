/**
 * CreateDropdown.tsx — The CREATE menu in the HeaderBar.
 *
 * Top-level entries:
 *   Images  → GIMP       (toggles imageEditorOpen)
 *   Text  ▶ → submenu:
 *               Document → Jodit + pandoc-wasm  (toggles joditPanelOpen)
 *               PDF      → Stirling PDF (toggles stirlingPanelOpen)
 *               Code     → Monaco      (toggles monacoPanelOpen)
 *   Audio   → Efflux DAW (toggles dawPanelOpen)
 *   Videos  → Omniclip   (toggles videosPanelOpen)
 *   3D    ▶ → submenu:
 *               Blockbench → Blockbench 3D editor (toggles blockbenchPanelOpen)
 *               SculptGL   → SculptGL sculpting   (toggles sculptglPanelOpen)
 *               Godot      → Godot web editor     (toggles godotPanelOpen)
 *
 * Z-index fix: the dropdown and submenu are rendered via ReactDOM.createPortal
 * into document.body so they escape any stacking context created by parent divs.
 *
 * Submenu positioning: computed in a useLayoutEffect after the menu is mounted,
 * not during render. Computing getBoundingClientRect() during render reads stale
 * refs and returns null, causing submenus to never appear.
 *
 * Mutually exclusive: opening any CREATE panel closes all others first.
 */

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, ChevronRight,
  Image as ImageIcon, FileText, Music2, Film,
  FileCode2, FilePlus, FileType, Boxes,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { useTheme } from '@/lib/useTheme';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TopEntry {
  id:         string;
  label:      string;
  Icon:       typeof ImageIcon;
  hasSubmenu: boolean;
  onSelect:   (() => void) | null;
  open:       boolean;
}

interface SubEntry {
  id:       string;
  label:    string;
  Icon:     typeof FileCode2;
  onSelect: () => void;
  open:     boolean;
}

// ── Hook: anchor rect (re-reads after layout) ─────────────────────────────────

function useAnchorRect(ref: React.RefObject<HTMLButtonElement>, open: boolean) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) { setRect(null); return; }
    const update = () => setRect(ref.current!.getBoundingClientRect());
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, ref]);

  return rect;
}

// ── Hook: submenu row rect (reads after menu DOM commits) ─────────────────────

function useRowRect(
  menuRef: React.RefObject<HTMLDivElement>,
  labelPrefix: string,
  active: boolean,
): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!active) { setRect(null); return; }

    const compute = () => {
      const menuEl = menuRef.current;
      if (!menuEl) return;
      const rows = menuEl.querySelectorAll('button');
      const row  = Array.from(rows).find((b) =>
        b.textContent?.trim().toUpperCase().startsWith(labelPrefix.toUpperCase())
      );
      if (row) setRect(row.getBoundingClientRect());
    };

    // Run after paint so the menu DOM is committed and refs are populated
    const raf = requestAnimationFrame(compute);
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [active, menuRef, labelPrefix]);

  return rect;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CreateDropdown() {
  const imageEditorOpen       = useAppStore((s) => s.imageEditorOpen);
  const toggleImageEditor     = useAppStore((s) => s.toggleImageEditor);
  const dawPanelOpen          = useAppStore((s) => s.dawPanelOpen);
  const toggleDawPanel        = useAppStore((s) => s.toggleDawPanel);
  const monacoPanelOpen       = useAppStore((s) => s.monacoPanelOpen);
  const toggleMonacoPanel     = useAppStore((s) => s.toggleMonacoPanel);
  const joditPanelOpen        = useAppStore((s) => s.joditPanelOpen);
  const toggleJoditPanel      = useAppStore((s) => s.toggleJoditPanel);
  const stirlingPanelOpen     = useAppStore((s) => s.stirlingPanelOpen);
  const toggleStirlingPanel   = useAppStore((s) => s.toggleStirlingPanel);
  const videosPanelOpen       = useAppStore((s) => s.videosPanelOpen);
  const toggleVideosPanel     = useAppStore((s) => s.toggleVideosPanel);
  const blockbenchPanelOpen   = useAppStore((s) => s.blockbenchPanelOpen);
  const toggleBlockbenchPanel = useAppStore((s) => s.toggleBlockbenchPanel);
  const sculptglPanelOpen     = useAppStore((s) => s.sculptglPanelOpen);
  const toggleSculptGLPanel   = useAppStore((s) => s.toggleSculptGLPanel);
  const godotPanelOpen        = useAppStore((s) => s.godotPanelOpen);
  const toggleGodotPanel      = useAppStore((s) => s.toggleGodotPanel);
  const closeCreatePanels     = useAppStore((s) => s.closeCreatePanels);

  const [open,         setOpen]         = useState(false);
  const [textHovered,  setTextHovered]  = useState(false);
  const [subHovered,   setSubHovered]   = useState(false);
  const [d3Hovered,    setD3Hovered]    = useState(false);
  const [d3SubHovered, setD3SubHovered] = useState(false);

  const btnRef   = useRef<HTMLButtonElement>(null);
  const menuRef  = useRef<HTMLDivElement>(null);
  const subRef   = useRef<HTMLDivElement>(null);
  const d3SubRef = useRef<HTMLDivElement>(null);

  const anchorRect      = useAnchorRect(btnRef, open);
  const textSubmenuOpen = textHovered || subHovered;
  const d3SubmenuOpen   = d3Hovered   || d3SubHovered;

  // Submenu positions computed after menu DOM commits — not during render
  const textRowRect = useRowRect(menuRef, 'TEXT', open && textSubmenuOpen);
  const d3RowRect   = useRowRect(menuRef, '3D',   open && d3SubmenuOpen);

  const closeAll = useCallback(() => {
    setOpen(false);
    setTextHovered(false);
    setSubHovered(false);
    setD3Hovered(false);
    setD3SubHovered(false);
  }, []);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !subRef.current?.contains(e.target as Node) &&
        !d3SubRef.current?.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) closeAll();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeAll(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown',   onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown',   onKey);
    };
  }, [open, closeAll]);

  const select = useCallback((toggle: () => void) => {
    closeCreatePanels();
    toggle();
    closeAll();
  }, [closeCreatePanels, closeAll]);

  const d3PanelOpen   = blockbenchPanelOpen || sculptglPanelOpen || godotPanelOpen;
  const textPanelOpen = monacoPanelOpen || joditPanelOpen || stirlingPanelOpen;
  const anyOpen       = imageEditorOpen || dawPanelOpen || monacoPanelOpen || joditPanelOpen
                      || stirlingPanelOpen || videosPanelOpen
                      || blockbenchPanelOpen || sculptglPanelOpen || godotPanelOpen;

  const topEntries: TopEntry[] = [
    { id: 'images', label: 'Images', Icon: ImageIcon, hasSubmenu: false, onSelect: () => select(toggleImageEditor),   open: imageEditorOpen },
    { id: 'text',   label: 'Text',   Icon: FileText,  hasSubmenu: true,  onSelect: null,                              open: textPanelOpen   },
    { id: 'audio',  label: 'Audio',  Icon: Music2,    hasSubmenu: false, onSelect: () => select(toggleDawPanel),      open: dawPanelOpen    },
    { id: 'videos', label: 'Videos', Icon: Film,      hasSubmenu: false, onSelect: () => select(toggleVideosPanel),   open: videosPanelOpen },
    { id: '3d',     label: '3D',     Icon: Boxes,     hasSubmenu: true,  onSelect: null,                              open: d3PanelOpen     },
  ];

  const subEntries: SubEntry[] = [
    { id: 'document', label: 'Document', Icon: FilePlus,  onSelect: () => select(toggleJoditPanel),    open: joditPanelOpen    },
    { id: 'pdf',      label: 'PDF',      Icon: FileType,  onSelect: () => select(toggleStirlingPanel), open: stirlingPanelOpen },
    { id: 'code',     label: 'Code',     Icon: FileCode2, onSelect: () => select(toggleMonacoPanel),   open: monacoPanelOpen   },
  ];

  const d3SubEntries: SubEntry[] = [
    { id: 'blockbench', label: 'Blockbench', Icon: Boxes, onSelect: () => select(toggleBlockbenchPanel), open: blockbenchPanelOpen },
    { id: 'sculptgl',   label: 'SculptGL',   Icon: Boxes, onSelect: () => select(toggleSculptGLPanel),   open: sculptglPanelOpen   },
    { id: 'godot',      label: 'Godot',      Icon: Boxes, onSelect: () => select(toggleGodotPanel),      open: godotPanelOpen      },
  ];

  const dropdownLeft = anchorRect ? anchorRect.right - 180 : 0;
  const dropdownTop  = anchorRect ? anchorRect.bottom + 4  : 0;

  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === 'light' || document.documentElement.classList.contains('light');

  const menuStyle: React.CSSProperties = isLight
    ? { background: 'hsl(35 25% 91%)', borderColor: 'hsl(130 45% 40% / 0.5)', boxShadow: '0 4px 20px rgba(10,20,50,0.2)' }
    : {};

  const itemStyle = (active: boolean): React.CSSProperties => isLight
    ? { color: active ? 'hsl(130 55% 18%)' : 'hsl(130 55% 22%)', fontWeight: 600 }
    : {};

  const subMenuClass = "phobos-panel bg-background border border-phobos-green/30 rounded-sm shadow-[0_0_12px_hsl(120_100%_50%/0.12)] min-w-[160px] overflow-hidden";
  const subBtnClass  = (active: boolean) =>
    `w-full flex items-center justify-between gap-3 px-3 py-2 text-[10px] font-terminal uppercase tracking-[0.12em] transition-all border-l-2 ${
      active
        ? 'text-phobos-green border-phobos-green/70 bg-phobos-green/[0.04]'
        : 'text-phobos-green/60 border-transparent hover:text-phobos-green hover:border-phobos-green/40 hover:bg-phobos-green/[0.03]'
    }`;

  const dropdown = open && anchorRect ? createPortal(
    <>
      {/* ── Main menu ──────────────────────────────────────────────────── */}
      <div
        ref={menuRef}
        style={{ position: 'fixed', top: dropdownTop, left: Math.max(4, dropdownLeft), zIndex: 9999, ...menuStyle }}
        className="phobos-panel bg-background border border-phobos-green/30 rounded-sm shadow-[0_0_12px_hsl(120_100%_50%/0.12)] min-w-[180px] overflow-visible"
      >
        {topEntries.map((e) => {
          const active = e.open;
          const isText = e.id === 'text';
          const is3d   = e.id === '3d';
          return (
            <div
              key={e.id}
              className="relative"
              onMouseEnter={() => { if (isText) setTextHovered(true); if (is3d) setD3Hovered(true); }}
              onMouseLeave={() => { if (isText) setTextHovered(false); if (is3d) setD3Hovered(false); }}
            >
              <button
                onClick={e.hasSubmenu ? undefined : (e.onSelect ?? undefined)}
                style={itemStyle(active)}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2 text-[10px] font-terminal uppercase tracking-[0.12em] transition-all border-l-2 ${
                  active
                    ? 'text-phobos-green border-phobos-green/70 bg-phobos-green/[0.04]'
                    : (isText && textSubmenuOpen) || (is3d && d3SubmenuOpen)
                      ? 'text-phobos-green/80 border-phobos-green/30 bg-phobos-green/[0.03]'
                      : 'text-phobos-green/60 border-transparent hover:text-phobos-green hover:border-phobos-green/40 hover:bg-phobos-green/[0.03]'
                }`}
              >
                <span className="flex items-center gap-2">
                  <e.Icon className="w-3 h-3 shrink-0" />
                  {e.label}
                </span>
                <span className="flex items-center gap-1">
                  {active && !e.hasSubmenu && (
                    <span className="w-1.5 h-1.5 rounded-full bg-phobos-green/80 animate-pulse" />
                  )}
                  {e.hasSubmenu && (
                    <ChevronRight className="w-2.5 h-2.5 text-muted-foreground/40" />
                  )}
                </span>
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Text submenu ───────────────────────────────────────────────── */}
      {textSubmenuOpen && textRowRect && (
        <div
          ref={subRef}
          style={{ position: 'fixed', top: textRowRect.top, left: textRowRect.right + 1, zIndex: 9999, ...menuStyle }}
          onMouseEnter={() => setSubHovered(true)}
          onMouseLeave={() => setSubHovered(false)}
          className={subMenuClass}
        >
          {subEntries.map((sub) => (
            <button key={sub.id} onClick={sub.onSelect} style={itemStyle(sub.open)} className={subBtnClass(sub.open)}>
              <span className="flex items-center gap-2">
                <sub.Icon className="w-3 h-3 shrink-0" />
                {sub.label}
              </span>
              {sub.open && <span className="w-1.5 h-1.5 rounded-full bg-phobos-green/80 animate-pulse shrink-0" />}
            </button>
          ))}
        </div>
      )}

      {/* ── 3D submenu ─────────────────────────────────────────────────── */}
      {d3SubmenuOpen && d3RowRect && (
        <div
          ref={d3SubRef}
          style={{ position: 'fixed', top: d3RowRect.top, left: d3RowRect.right + 1, zIndex: 9999, ...menuStyle }}
          onMouseEnter={() => setD3SubHovered(true)}
          onMouseLeave={() => setD3SubHovered(false)}
          className={subMenuClass}
        >
          {d3SubEntries.map((sub) => (
            <button key={sub.id} onClick={sub.onSelect} style={itemStyle(sub.open)} className={subBtnClass(sub.open)}>
              <span className="flex items-center gap-2">
                <sub.Icon className="w-3 h-3 shrink-0" />
                {sub.label}
              </span>
              {sub.open && <span className="w-1.5 h-1.5 rounded-full bg-phobos-green/80 animate-pulse shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </>,
    document.body
  ) : null;

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 px-4 py-1 text-[10px] font-terminal uppercase tracking-[0.15em] rounded-sm border transition-all ${
          anyOpen
            ? 'border-phobos-green/50 text-phobos-green hover:border-phobos-green/70'
            : 'border-phobos-green/20 text-phobos-green/60 hover:text-phobos-green hover:border-phobos-green/40 hover:shadow-[0_0_8px_hsl(120_100%_50%/0.1)]'
        }`}
      >
        CREATE
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {dropdown}
    </div>
  );
}