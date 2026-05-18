import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

interface Props {
  content: string;
  modelName?: string;
}

export function ThinkingTrace({ content, modelName }: Props) {
  const [open, setOpen] = useState(false);
  const label = modelName ? `${modelName} reasoning` : 'Reasoning';

  return (
    <div className="mt-2 border border-border/30 rounded-sm overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground/60 hover:text-foreground hover:bg-accent/30 transition-colors"
      >
        <ChevronRight
          className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="font-mono text-[11px]">{label}</span>
      </button>
      {open && (
        <div className="px-3 py-2 border-t border-border/20 bg-muted/20">
          <pre className="text-[11px] font-mono text-muted-foreground/60 whitespace-pre-wrap leading-relaxed animate-ink">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}
