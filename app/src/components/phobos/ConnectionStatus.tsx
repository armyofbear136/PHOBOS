import { useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

export function ConnectionStatus() {
  const togglePhobosLLMPanel = useAppStore((s) => s.togglePhobosLLMPanel);
  const [checking, setChecking] = useState(false);

  const handleCheckConnection = async () => {
    setChecking(true);
    try {
      const res = await fetch(`${ENGINE_URL}/api/status`);
      if (res.ok) {
        const data = await res.json();
        useAppStore.getState().setConnectionStatus({
          coordinator: data.coordinator ?? 'disconnected',
          engine: data.engine ?? 'disconnected',
        });
      }
    } catch { /* silent */ } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center px-4">
      <div className="max-w-sm w-full text-center p-8  border border-phob-orange/25 bg-phob-white/4 phob-corners">
        <AlertTriangle className="w-8 h-8 text-phob-amber/60 mx-auto mb-4" />
        <h3 className="text-sm font-terminal text-phob-amber/80 tracking-wider mb-2">
          SEREN is offline
        </h3>
        <p className="text-[11px] text-phob-steel/40 leading-relaxed mb-4">
          The AI engine is not responding. This usually means:
        </p>
        <ul className="text-[10px] text-phob-steel/30 space-y-1 mb-6 text-left max-w-[260px] mx-auto">
          <li>• The local LLM server is still starting up</li>
          <li>• The model hasn't finished loading into memory</li>
        </ul>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={handleCheckConnection}
            disabled={checking}
            className="flex items-center gap-1.5 px-4 py-2 border border-phob-green/25 text-phob-green/60 text-[10px] font-terminal uppercase tracking-[0.1em]  hover:text-phob-green hover:border-phob-green/40 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-3 h-3 ${checking ? 'animate-spin' : ''}`} />
            {checking ? 'CHECKING...' : 'CHECK CONNECTION'}
          </button>
          <button
            onClick={togglePhobosLLMPanel}
            className="flex items-center gap-1.5 px-4 py-2 border border-phob-orange/15 text-phob-steel/40 text-[10px] font-terminal uppercase tracking-[0.1em]  hover:text-phob-steel/70 hover:border-phob-orange/25 transition-all"
          >
            Open PHOBOS LLMs ▸
          </button>
        </div>
      </div>
    </div>
  );
}
