import { useState } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

interface Props {
  docKey: 'claudeMd' | 'chatMd';
  onClose: () => void;
}

const titles: Record<string, string> = {
  claudeMd: 'PHOBOS DIRECTIVES',
  chatMd: 'chat.md',
};

export function DocumentEditor({ docKey, onClose }: Props) {
  const doc = useAppStore((s) => s.documents[docKey]);
  const updateDocument = useAppStore((s) => s.updateDocument);
  const [value, setValue] = useState(doc);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-full max-w-2xl bg-card border border-border rounded-md shadow-2xl flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-mono font-medium text-foreground">{titles[docKey]}</span>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-accent text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 p-4 bg-transparent text-sm font-mono text-foreground resize-none focus:outline-none scrollbar-thin"
          spellCheck={false}
        />
        <div className="flex justify-end px-4 py-3 border-t border-border">
          <button
            onClick={() => {
              updateDocument(docKey, value);
              onClose();
            }}
            className="px-4 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
