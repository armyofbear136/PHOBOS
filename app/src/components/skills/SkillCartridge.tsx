import { useState, useRef, useEffect } from 'react';
import { useTheme } from '@/lib/useTheme';
import { SkillsMenu } from './SkillsMenu';
import { PluginsMenu } from '../plugins/PluginsMenu';
import { CartridgesPanel } from '../cartridges/CartridgesPanel';
import { ArchivePanel } from '../archive/ArchivePanel';
import { WeclonePanel } from '../cartridges/WeclonePanel';
import { HomeAssistantPanel } from '../homeassistant/HomeAssistantPanel';

export function SkillCartridge() {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [skillsOpen,   setSkillsOpen]   = useState(false);
  const [artOpen,      setArtOpen]       = useState(false);
  const [aiOpen,       setAiOpen]        = useState(false);
  const [archiveOpen,  setArchiveOpen]   = useState(false);
  const [wecloneOpen,  setWecloneOpen]   = useState(false);
  const [haOpen,       setHaOpen]         = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === 'light' || document.documentElement.classList.contains('light');

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const itemStyle: React.CSSProperties = isLight ? {
    color: '#1a3a1a',
    borderBottomColor: 'hsl(35 20% 72%)',
    fontWeight: 600,
  } : {};

  const iconStyle: React.CSSProperties = isLight ? {
    color: '#1a3a1a',
  } : {};

  const dropdownStyle: React.CSSProperties = isLight ? {
    background: 'hsl(35 25% 91%)',
    borderColor: 'hsl(130 45% 40% / 0.45)',
  } : {};

  const handleItemHover = (e: React.MouseEvent<HTMLButtonElement>, entering: boolean) => {
    if (!isLight) return;
    e.currentTarget.style.background = entering ? 'hsl(220 55% 18%)' : 'none';
    e.currentTarget.style.color      = entering ? 'hsl(130 65% 62%)' : 'hsl(130 55% 18%)';
  };

  return (
    <>
      <div ref={ref} style={{ position: 'relative' }}>
        <button
          onClick={() => setDropdownOpen(d => !d)}
          className="skill-cartridge group"
          title="Cartridges"
        >
          <div className="skill-cartridge-body skill-cartridge-body--wide">
            <div className="skill-cartridge-label">
              <span className="text-[8px] font-terminal uppercase tracking-[0.2em] text-phobos-green/70 group-hover:text-phobos-green transition-colors">
                CYBERNETICS
              </span>
            </div>
            <div className="skill-cartridge-pins" />
          </div>
        </button>

        {dropdownOpen && (
          <div className="skill-cartridge-dropdown" style={dropdownStyle}>
            {[
              { icon: '◈', label: 'Instruction Tapes', action: () => setSkillsOpen(true) },
              { icon: '◆', label: 'Cortex Cartridges', action: () => setAiOpen(true) },
              { icon: '◉', label: 'Digital Clone',     action: () => setWecloneOpen(true) },
              { icon: '◇', label: 'Art Plugins',       action: () => setArtOpen(true) },
              { icon: '◆', label: 'Audio Patches',     action: () => setAiOpen(true) },
              { icon: '◫', label: 'Archive Payloads',  action: () => setArchiveOpen(true) },
              { icon: '⌂', label: 'Home Assistant',    action: () => setHaOpen(true) },
            ].map(({ icon, label, action }) => (
              <button
                key={label}
                className="skill-cartridge-dropdown-item"
                style={itemStyle}
                onMouseEnter={e => handleItemHover(e, true)}
                onMouseLeave={e => handleItemHover(e, false)}
                onClick={() => { setDropdownOpen(false); action(); }}
              >
                <span className="skill-cartridge-dropdown-icon" style={iconStyle}>{icon}</span>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {skillsOpen   && <SkillsMenu      onClose={() => setSkillsOpen(false)} />}
      {artOpen      && <PluginsMenu     onClose={() => setArtOpen(false)} />}
      {aiOpen       && <CartridgesPanel onClose={() => setAiOpen(false)} />}
      {wecloneOpen  && <WeclonePanel    onClose={() => setWecloneOpen(false)} />}
      {archiveOpen  && <ArchivePanel    onClose={() => setArchiveOpen(false)} />}
      {haOpen       && <HomeAssistantPanel onClose={() => setHaOpen(false)} />}
    </>
  );
}