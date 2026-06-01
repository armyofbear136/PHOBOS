import { useState, useRef, useEffect } from 'react';
import { Cpu, PanelRight, ChevronDown, Download, Puzzle, CalendarClock, X as XIcon, Music2, Film, Crown, Tv, Key, BookMarked, Shield, DollarSign, Users, Wifi, WifiOff } from 'lucide-react';
import PolarisPlayer from '@/components/media/PolarisPlayer';
import { MediaHubPanel } from '@/components/media/MediaHubPanel';
import { lazy, Suspense } from 'react';
const KavitaBrowser   = lazy(() => import('@/components/media/KavitaBrowser'));
const JellyfinBrowser = lazy(() => import('@/components/media/JellyfinBrowser'));
const IPTVPlayer      = lazy(() => import('@/components/media/IPTVPlayer'));
const MeridianViewer  = lazy(() => import('@/components/meridian/MeridianViewer').then(m => ({ default: m.MeridianViewer })));
const MeridianBrowser = lazy(() => import('@/components/meridian/MeridianBrowser'));
import { useAppStore } from '@/store/useAppStore';
import { FileEditorWindow } from '@/components/chat/FileEditorWindow';
import { useModelConfig } from '@/hooks/useThread';
import { SkillCartridge } from '@/components/skills/SkillCartridge';
import { PhobosLLMPanel } from '@/components/phobos/PhobosLLMPanel';
import { LicenseDialog } from '@/components/phobos/LicenseDialog';
import { SchedulerPanel } from '@/components/scheduler/SchedulerPanel';
import { SecurityPanel }  from '@/components/security/SecurityPanel';
import { VaultPanel } from '@/components/vault/VaultPanel';
import { UserManagementPanel } from '@/components/users/UserManagementPanel';
import { CreateDropdown } from '@/components/ui/CreateDropdown';
import { useSchedulerPending } from '@/hooks/useSchedulerPending';
import { FinancePanel } from '@/components/finance/FinancePanel';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface Provider {
  id: string;
  label: string;
  defaultEndpoint: string;
  requiresApiKey: boolean;
}

interface ModelOption {
  id: string;
  label: string;
  provider: string;
}

interface RoleConfig {
  provider: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  options: ModelOption[];
  providers: Provider[];
}

interface ModelPickerProps {
  role: 'coordinator' | 'engine';
  roleLabel: string;
  config: RoleConfig | null;
  currentModel: string;
  connected: boolean;
  onSelectProvider: (providerId: string, endpoint: string) => void;
  onSelectModel: (modelId: string) => void;
}

function ModelPicker({ role, roleLabel, config, currentModel, connected, onSelectProvider, onSelectModel }: ModelPickerProps) {
  const [providerOpen, setProviderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const providerRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);

  const roleTintClass = role === 'coordinator' ? 'text-sayon' : 'text-seren';

  useEffect(() => {
    if (!providerOpen && !modelOpen) return;
    const handler = (e: MouseEvent) => {
      if (providerRef.current && !providerRef.current.contains(e.target as Node)) setProviderOpen(false);
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [providerOpen, modelOpen]);

  const providers = config?.providers ?? [];
  const currentProvider = config?.provider ?? '';
  const currentProviderLabel = providers.find(p => p.id === currentProvider)?.label ?? currentProvider.toUpperCase();

  const models = config?.options ?? [];
  const currentModelLabel = models.find(m => m.id === currentModel)?.label ?? currentModel;

  return (
    <div className="flex items-center gap-0.5">
      <div className="relative" ref={providerRef}>
        <button
          onClick={() => { setProviderOpen(!providerOpen); setModelOpen(false); }}
          className="flex items-center gap-1.5 px-2 py-1 hover:bg-phob-orange/8 transition-all group"
        >
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${connected ? 'bg-phob-green phob-dot-static' : 'bg-phob-red'}`} />
          <img
            src={roleLabel === 'SAYON' ? `${import.meta.env.BASE_URL}sayon.png` : `${import.meta.env.BASE_URL}seren.png`}
            alt={roleLabel}
            className="w-4 h-4 rounded-sm object-cover opacity-75"
          />
          <span className={`text-xs font-mono transition-colors ${
            roleLabel === 'SAYON' ? 'text-sayon group-hover:text-sayon/80' : 'text-seren group-hover:text-seren/80'
          }`}>
            {roleLabel}
          </span>
          <ChevronDown className="w-2.5 h-2.5 text-phob-orange/30" />
        </button>

        {providerOpen && (
          <div className="absolute top-full left-0 mt-1 w-44 bg-[#0f0f0a] border border-phob-orange/25 shadow-xl z-50 overflow-hidden">
            <div className="px-3 py-1.5 border-b border-phob-orange/15">
              <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">
                {roleLabel} Provider
              </span>
            </div>
            {providers.map(p => (
              <button
                key={p.id}
                onClick={() => {
                  onSelectProvider(p.id, p.defaultEndpoint);
                  setProviderOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs font-mono transition-all hover:bg-phob-orange/8 ${
                  p.id === currentProvider
                    ? `${roleTintClass} bg-phob-orange/5`
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {p.id === currentProvider && <span className={`w-1 h-1 rounded-full shrink-0 ${role === 'coordinator' ? 'bg-sayon' : 'bg-seren'}`} />}
                {p.id !== currentProvider && <span className="w-1 shrink-0" />}
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="text-ui-glow text-xs font-mono">·</span>

      <div className="relative" ref={modelRef}>
        <button
          onClick={() => { setModelOpen(!modelOpen); setProviderOpen(false); }}
          className="flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-accent transition-all group"
        >
          <span className="text-xs font-mono text-phob-orange/70 group-hover:text-phob-orange transition-colors">
            {currentModelLabel}
          </span>
          <ChevronDown className="w-2.5 h-2.5 text-phob-orange/25 group-hover:text-phob-orange/50 transition-colors" />
        </button>

        {modelOpen && (
          <div className="absolute top-full right-0 mt-1 w-48 bg-[#0f0f0a] border border-phob-orange/25 shadow-xl z-50 overflow-hidden">
            <div className="px-3 py-1.5 border-b border-border/50">
              <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">
                {currentProviderLabel} Models
              </span>
            </div>
            {models.length === 0 && (
              <div className="px-3 py-3 text-[11px] font-mono text-muted-foreground/40 italic">
                Custom — type model ID in config
              </div>
            )}
            {models.map(opt => {
              const isSelected = opt.id === currentModel;
              const modelRole = (opt as any).role as string | undefined;
              const modelTint = modelRole === 'seren' ? 'text-seren' : modelRole === 'sayon' ? 'text-sayon' : '';
              return (
                <button
                  key={opt.id}
                  onClick={() => { onSelectModel(opt.id); setModelOpen(false); }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs font-mono transition-all hover:bg-accent ${
                    isSelected
                      ? `${roleTintClass} bg-phob-orange/5`
                      : modelTint || 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {isSelected && <span className={`w-1 h-1 rounded-full shrink-0 ${role === 'coordinator' ? 'bg-sayon' : 'bg-seren'}`} />}
                  {!isSelected && <span className="w-1 shrink-0" />}
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Halcyon Popover ─── */

function HalcyonButton() {
  const halcyonOptIn = useAppStore((s) => s.halcyonOptIn);
  const setHalcyonOptIn = useAppStore((s) => s.setHalcyonOptIn);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!popoverOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPopoverOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popoverOpen]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setPopoverOpen(!popoverOpen)}
        className={`px-4 py-1 text-[10px] font-terminal uppercase tracking-[0.15em] rounded-sm border transition-all flex items-center gap-1.5 ${
          halcyonOptIn
            ? 'border-phob-amber/30 text-phob-amber/60 hover:text-phob-amber hover:border-phob-amber/50'
            : 'border-phob-orange/15 text-phob-steel/30 hover:text-phob-steel/50'
        }`}
      >
        HALCYON
        {halcyonOptIn && (
          <span className="phob-dot text-phob-amber" />
        )}
      </button>

      {popoverOpen && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-64 bg-[#0f0f0a] border border-phob-amber/25 p-3 z-50 shadow-[0_0_16px_rgba(200,160,0,0.08)]">
          <div className="text-[10px] font-terminal text-phob-amber/70 tracking-[0.15em] uppercase mb-2">
            CONTRIBUTE TO HALCYON
          </div>
          <p className="text-[11px] font-mono text-muted-foreground/40 leading-relaxed mb-3">
            Opt in to share anonymized PHOBOS session data to help train the Halcyon community model. You can opt out at any time.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { window.open('https://autarch.net/halcyon', '_blank'); setPopoverOpen(false); }}
              className="px-3 py-1 text-[10px] font-terminal uppercase tracking-[0.1em] rounded-sm border border-border/20 text-muted-foreground/40 hover:text-muted-foreground transition-all"
            >
              LEARN MORE
            </button>
            {halcyonOptIn ? (
              <button
                onClick={() => { setHalcyonOptIn(false); setPopoverOpen(false); }}
                className="px-3 py-1 text-[10px] font-terminal uppercase tracking-[0.1em] rounded-sm border border-destructive/30 text-destructive/60 hover:text-destructive hover:border-destructive/50 transition-all"
              >
                OPT OUT
              </button>
            ) : (
              <button
                onClick={() => { setHalcyonOptIn(true); setPopoverOpen(false); }}
                className="px-3 py-1 text-[10px] font-terminal uppercase tracking-[0.1em] rounded-sm border border-phob-amber/30 text-phob-amber/60 hover:text-phob-amber hover:border-phob-amber/50 transition-all"
              >
                OPT IN
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function HeaderBar() {
  const { connectionStatus, cycleCopilot } = useAppStore();
  const copilotMode = useAppStore((s) => s.copilotMode);

  const modelConfig  = useAppStore((s) => s.modelConfig);
  const modelNames   = useAppStore((s) => s.modelNames);
  const documents    = useAppStore((s) => s.documents);
  const updateDocument = useAppStore((s) => s.updateDocument);
  const phobosOpen   = useAppStore((s) => s.phobosLLMPanelOpen);
  const togglePhobosLLMPanel = useAppStore((s) => s.togglePhobosLLMPanel);
  const togglePolarisPlayer = useAppStore((s) => s.togglePolarisPlayer);
  const kavitaBrowserOpen    = useAppStore((s) => s.kavitaBrowserOpen);
  const toggleKavitaBrowser  = useAppStore((s) => s.toggleKavitaBrowser);
  const jellyfinBrowserOpen  = useAppStore((s) => s.jellyfinBrowserOpen);
  const iptvPlayerOpen       = useAppStore((s) => s.iptvPlayerOpen);
  const meridianViewerOpen   = useAppStore((s) => s.meridianViewerOpen);
  const meridianBrowserOpen  = useAppStore((s) => s.meridianBrowserOpen);
  const toggleJellyfinBrowser = useAppStore((s) => s.toggleJellyfinBrowser);
  const toggleIptvPlayer      = useAppStore((s) => s.toggleIptvPlayer);
  const toggleMeridianViewer  = useAppStore((s) => s.toggleMeridianViewer);
  const toggleMeridianBrowser = useAppStore((s) => s.toggleMeridianBrowser);
  const financeOpen       = useAppStore((s) => s.financeOpen);
  const toggleFinancePanel = useAppStore((s) => s.toggleFinancePanel);
  const configOptimal = useAppStore((s) => s.configOptimal);
  const licenseUsername    = useAppStore((s) => s.licenseUsername);
  const phobosCoins        = useAppStore((s) => s.phobosCoins);
  const gameFocused        = useAppStore((s) => s.gameFocused);
  const setGameFocused     = useAppStore((s) => s.setGameFocused);
  const licenseChecked     = useAppStore((s) => s.licenseChecked);
  const setLicenseUsername = useAppStore((s) => s.setLicenseUsername);
  const setLicenseChecked  = useAppStore((s) => s.setLicenseChecked);
  const { updateConfig } = useModelConfig();
  const [editingUserDirectives, setEditingUserDirectives] = useState(false);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const schedulerOpen    = useAppStore((s) => s.schedulerOpen);
  const setSchedulerOpen = useAppStore((s) => s.setSchedulerOpen);
  const securityOpen     = useAppStore((s) => s.securityOpen);
  const setSecurityOpen  = useAppStore((s) => s.setSecurityOpen);
  const vaultOpen     = useAppStore((s) => s.vaultOpen);
  const setVaultOpen  = useAppStore((s) => s.setVaultOpen);
  const userMgmtOpen    = useAppStore((s) => s.userMgmtOpen);
  const setUserMgmtOpen = useAppStore((s) => s.setUserMgmtOpen);
  const [mediaHubOpen, setMediaHubOpen] = useState(false);
  const { pending, cancelPending } = useSchedulerPending();
  const activeThreadId = useAppStore((s) => s.activeThreadId);

  // ── Relay toggle state ────────────────────────────────────────────────────
  const [relayEnabled, setRelayEnabled]   = useState(true);
  const [relayConnected, setRelayConnected] = useState(false);
  const [relayToggling, setRelayToggling] = useState(false);

  useEffect(() => {
    fetch(`${ENGINE_URL}/api/webrtc/status`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { relayEnabled?: boolean; relayConnected?: boolean } | null) => {
        if (data) {
          setRelayEnabled(data.relayEnabled ?? true);
          setRelayConnected(data.relayConnected ?? false);
        }
      })
      .catch(() => {});
  }, []);

  async function toggleRelay() {
    if (relayToggling) return;
    setRelayToggling(true);
    const next = !relayEnabled;
    try {
      const r = await fetch(`${ENGINE_URL}/api/webrtc/relay/${next ? 'enable' : 'disable'}`, { method: 'POST' });
      if (r.ok) { setRelayEnabled(next); setRelayConnected(next); }
    } catch {}
    setRelayToggling(false);
  }

    // Check license once on mount — sets username in store for the header display
  useEffect(() => {
    if (licenseChecked) return;
    fetch(`${ENGINE_URL}/api/license`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { valid: boolean; username?: string | null } | null) => {
        if (data?.valid && data.username) setLicenseUsername(data.username);
        setLicenseChecked(true);
      })
      .catch(() => setLicenseChecked(true));
  }, [licenseChecked, setLicenseUsername, setLicenseChecked]);

  return (
    <>
      <header className="phobos-header phob-chrome-zone phob-scan-line h-11 flex items-center justify-between px-3 border-b-2 border-phob-orange/40 bg-[#080808] shrink-0 relative z-50 overflow-visible">
        <div className="flex items-center gap-2">
          {/* ── Relay toggle — leftmost control ── */}
          <button
            onClick={() => void toggleRelay()}
            disabled={relayToggling}
            title={relayEnabled ? (relayConnected ? 'Relay connected — click to go offline' : 'Relay enabled but disconnected') : 'Relay disabled — click to connect'}
            className="p-1.5 transition-all border"
            style={{
              borderColor: relayEnabled ? (relayConnected ? 'rgba(80,220,120,0.45)' : 'rgba(232,66,10,0.3)') : 'rgba(136,136,128,0.2)',
              color: relayEnabled ? (relayConnected ? 'rgba(80,220,120,0.85)' : 'rgba(232,66,10,0.5)') : 'rgba(136,136,128,0.35)',
              background: relayEnabled && relayConnected ? 'rgba(80,220,120,0.06)' : 'transparent',
              opacity: relayToggling ? 0.5 : 1,
            }}
          >
            {relayEnabled ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
          </button>

          {/* Autarch icon — opens autarch.net in browser */}
          <button
            onClick={() => window.open('https://autarch.net', '_blank')}
            className="p-1 hover:bg-phob-orange/8 transition-colors"
            title="Back to Autarch Industries"
          >
            <img src={`${import.meta.env.BASE_URL}autarch-icon.svg`} alt="Autarch" className="w-5 h-5" />
          </button>
          <Cpu className="w-4 h-4 text-phob-orange/50" />
          <span className="text-[11px] font-terminal font-semibold text-phob-orange tracking-[0.2em]">PHOBOS | {licenseUsername ? licenseUsername.toUpperCase() : 'TWIN SUN'}</span>

          {/* ── Phobos coin counter ── */}
          <span
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono border border-phob-amber/20 text-phob-amber/70"
            title="Phobos coins"
          >
            ◈ {phobosCoins}
          </span>

          {/* ── WORLD / UI MODE toggle ── */}
          <button
            onClick={() => setGameFocused(!gameFocused)}
            className={`px-2 py-0.5 text-[10px] font-terminal uppercase tracking-wider rounded-sm border transition-all ${
              gameFocused
                ? 'border-phob-orange/50 text-phob-orange bg-phob-orange/10 skew-x-[-4deg]'
                : 'border-phob-orange/20 text-phob-orange/50 hover:border-phob-orange/40 hover:text-phob-orange/80 skew-x-[-4deg]'
            }`}
            title="Toggle game focus (` key)"
          >
            {gameFocused ? '⊞ UI MODE' : '⊞ WORLD'}
          </button>
        </div>

        <HalcyonButton />
        <button
          onClick={togglePhobosLLMPanel}
          className="relative flex items-center gap-1.5 px-4 py-1 text-[10px] font-terminal uppercase tracking-[0.15em] border border-phob-orange/25 text-phob-orange/60 hover:text-phob-orange hover:border-phob-orange/50 hover:bg-phob-orange/5 skew-x-[-4deg] transition-all"
        >
          <Download className="w-3 h-3" />
          CONFIGURE
          {configOptimal === false && (
            <span className="absolute -top-1 -right-1 phob-dot text-phob-amber" title="Better config available" />
          )}
        </button>
        <button
          onClick={() => setEditingUserDirectives(true)}
          className="px-4 py-1 text-[10px] font-terminal uppercase tracking-[0.15em] border border-phob-orange/20 text-phob-orange/55 hover:text-phob-orange hover:border-phob-orange/40 hover:bg-phob-orange/5 skew-x-[-4deg] transition-all"
        >
          DIRECTIVES
        </button>
        {/* Cartridges — floating NES-style button with dropdown */}
        <SkillCartridge />
        <CreateDropdown />
        <button
          onClick={() => setMediaHubOpen(true)}
          className="flex items-center gap-1.5 px-4 py-1 text-[10px] font-terminal uppercase tracking-[0.15em] border border-phob-orange/20 text-phob-orange/55 hover:text-phob-orange hover:border-phob-orange/40 hover:bg-phob-orange/5 skew-x-[-4deg] transition-all"
          title="Media Hub"
        >
          <Film className="w-3 h-3" />
          MEDIA HUB
        </button>
        <button
          onClick={toggleIptvPlayer}
          className="flex items-center gap-1.5 px-4 py-1 text-[10px] font-terminal uppercase tracking-[0.15em] border border-phob-orange/20 text-phob-orange/55 hover:text-phob-orange hover:border-phob-orange/40 hover:bg-phob-orange/5 skew-x-[-4deg] transition-all"
          title="IPTV"
        >
          <Tv className="w-3 h-3" />
        </button>
        <button
          onClick={() => setVaultOpen(true)}
          title="Vault"
          className="p-1.5 border border-phob-orange/20 text-phob-orange/50 hover:text-phob-orange hover:border-phob-orange/40 hover:bg-phob-orange/5 transition-all"
        >
          <Key className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setUserMgmtOpen(true)}
          title="Users"
          className="p-1.5 border border-phob-orange/20 text-phob-orange/50 hover:text-phob-orange hover:border-phob-orange/40 hover:bg-phob-orange/5 transition-all"
        >
          <Users className="w-3.5 h-3.5" />
        </button>
        {/* Markets */}
        <button
          onClick={toggleFinancePanel}
          title="Markets"
          className="p-1.5 border border-phob-orange/20 text-phob-orange/50 hover:text-phob-orange hover:border-phob-orange/40 hover:bg-phob-orange/5 transition-all"
        >
          <DollarSign className="w-3.5 h-3.5" />
        </button>
        {/* Patrons — icon only */}
        <button
          onClick={() => setLicenseOpen(true)}
          title="Patrons"
          className="p-1.5 border border-phob-orange/20 text-phob-orange/50 hover:text-phob-orange hover:border-phob-orange/40 hover:bg-phob-orange/5 transition-all"
        >
          <Crown className="w-3.5 h-3.5" />
        </button>

        <div className="flex items-center gap-2">
          <ModelPicker
            role="coordinator"
            roleLabel="SAYON"
            config={modelConfig?.coordinator ?? null}
            currentModel={modelNames.coordinator}
            connected={connectionStatus.coordinator === 'connected'}
            onSelectProvider={(providerId, endpoint) =>
              updateConfig.mutate({ coordinator: { provider: providerId, endpoint } })
            }
            onSelectModel={(model) =>
              updateConfig.mutate({ coordinator: { model } })
            }
          />
          <ModelPicker
            role="engine"
            roleLabel="SEREN"
            config={modelConfig?.engine ?? null}
            currentModel={modelNames.engine}
            connected={connectionStatus.engine === 'connected'}
            onSelectProvider={(providerId, endpoint) =>
              updateConfig.mutate({ engine: { provider: providerId, endpoint } })
            }
            onSelectModel={(model) =>
              updateConfig.mutate({ engine: { model } })
            }
          />
          <button
            onClick={cycleCopilot}
            title={copilotMode === 'hidden' ? 'Open copilot' : copilotMode === 'compact' ? 'Expand copilot' : 'Hide copilot'}
            className={`p-1.5 hover:bg-phob-orange/8 transition-colors ml-1 ${
              copilotMode === 'expanded'
                ? 'text-phob-orange bg-phob-orange/10'
                : copilotMode === 'compact'
                  ? 'text-phob-orange/50'
                  : 'text-phob-orange/30'
            }`}
          >
            <PanelRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      {editingUserDirectives && (
        <FileEditorWindow
          filename="USER DIRECTIVES"
          initialContent={documents.userDirectivesMd}
          language="markdown"
          onClose={() => setEditingUserDirectives(false)}
          onSaveContent={async (content) => {
            updateDocument('userDirectivesMd', content);
            try {
              await fetch(`${ENGINE_URL}/api/documents/user-directives`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content }),
              });
            } catch { /* silent */ }
          }}
        />
      )}
      {schedulerOpen && <SchedulerPanel onClose={() => setSchedulerOpen(false)} />}
      {securityOpen  && <SecurityPanel />}
      {vaultOpen && <VaultPanel />}
      {userMgmtOpen && <UserManagementPanel />}
      {licenseOpen && <LicenseDialog onClose={() => setLicenseOpen(false)} />}
      {phobosOpen && <PhobosLLMPanel onClose={togglePhobosLLMPanel} />}
      {/* PolarisPlayer is mounted unconditionally; it self-hides when the
          shared playback store's `view` is not 'floating'. The legacy
          polarisPlayerOpen toggle in useAppStore remains for backwards
          compatibility but only controls the hidden ↔ floating transition;
          the dock in the sidebar handles dock ↔ floating itself. */}
      <PolarisPlayer />
      {kavitaBrowserOpen   && <Suspense fallback={null}><KavitaBrowser /></Suspense>}
      {jellyfinBrowserOpen  && <Suspense fallback={null}><JellyfinBrowser /></Suspense>}
      {iptvPlayerOpen       && <Suspense fallback={null}><IPTVPlayer /></Suspense>}
      {meridianViewerOpen   && <Suspense fallback={null}><MeridianViewer onClose={toggleMeridianViewer} libraryPath="" /></Suspense>}
      {meridianBrowserOpen  && <Suspense fallback={null}><MeridianBrowser /></Suspense>}
      {financeOpen && <FinancePanel onClose={toggleFinancePanel} />}
      {mediaHubOpen && <MediaHubPanel onClose={() => setMediaHubOpen(false)} />}
    </>
  );
}