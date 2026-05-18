import { useState, useRef, useEffect } from 'react';
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
          <div className="skill-cartridge-dropdown">
            <button
              className="skill-cartridge-dropdown-item"
              onClick={() => { setDropdownOpen(false); setSkillsOpen(true); }}
            >
              <span className="skill-cartridge-dropdown-icon">◈</span>
              Instruction Tapes
            </button>
            <button
              className="skill-cartridge-dropdown-item"
              onClick={() => { setDropdownOpen(false); setAiOpen(true); }}
            >
              <span className="skill-cartridge-dropdown-icon">◆</span>
              Cortex Cartridges
            </button>
            <button
              className="skill-cartridge-dropdown-item"
              onClick={() => { setDropdownOpen(false); setWecloneOpen(true); }}
            >
              <span className="skill-cartridge-dropdown-icon">◉</span>
              Digital Clone
            </button>
            <button
              className="skill-cartridge-dropdown-item"
              onClick={() => { setDropdownOpen(false); setArtOpen(true); }}
            >
              <span className="skill-cartridge-dropdown-icon">◇</span>
              Art Plugins
            </button>
            <button
              className="skill-cartridge-dropdown-item"
              onClick={() => { setDropdownOpen(false); setAiOpen(true); }}
            >
              <span className="skill-cartridge-dropdown-icon">◆</span>
              Audio Patches
            </button>
            <button
              className="skill-cartridge-dropdown-item"
              onClick={() => { setDropdownOpen(false); setArchiveOpen(true); }}
            >
              <span className="skill-cartridge-dropdown-icon">◫</span>
              Archive Payloads
            </button>
            <button
              className="skill-cartridge-dropdown-item"
              onClick={() => { setDropdownOpen(false); setHaOpen(true); }}
            >
              <span className="skill-cartridge-dropdown-icon">⌂</span>
              Home Assistant
            </button>
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