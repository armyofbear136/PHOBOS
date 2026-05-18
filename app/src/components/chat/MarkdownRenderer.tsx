import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import { useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface CodeBlockProps {
  language?: string;
  children: string;
}

function CodeBlock({ language, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    if (language && hljs.getLanguage(language)) {
      hljs.highlightElement(ref.current);
    } else {
      hljs.highlightElement(ref.current);
    }
  }, [children, language]);

  const handleCopy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="relative group/code my-2 rounded-md overflow-hidden border border-border/40">
      <div className="flex items-center justify-between px-3 py-1 bg-muted/60 border-b border-border/30">
        <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">
          {language || 'code'}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground transition-colors"
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="overflow-x-auto scrollbar-thin p-0 m-0 bg-black/60">
        <code
          ref={ref}
          className={`hljs language-${language || 'plaintext'} text-[11px] leading-relaxed block p-3`}
        >
          {children}
        </code>
      </pre>
    </div>
  );
}

interface Props {
  content: string;
}

export function MarkdownRenderer({ content }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          const isBlock = !props.node?.position || String(children).includes('\n');
          const lang = match?.[1];
          const text = String(children).replace(/\n$/, '');

          if (isBlock || lang) {
            return <CodeBlock language={lang}>{text}</CodeBlock>;
          }
          return (
            <code className="px-1 py-0.5 rounded bg-muted/60 text-[11px] font-mono text-phobos-green/80 border border-border/30">
              {children}
            </code>
          );
        },
        p({ children }) {
          return <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>;
        },
        h1({ children }) {
          return <h1 className="text-base font-terminal font-bold text-foreground mt-3 mb-1.5 tracking-wide">{children}</h1>;
        },
        h2({ children }) {
          return <h2 className="text-sm font-terminal font-semibold text-foreground mt-3 mb-1 tracking-wide">{children}</h2>;
        },
        h3({ children }) {
          return <h3 className="text-xs font-terminal font-semibold text-muted-foreground mt-2 mb-1 uppercase tracking-wider">{children}</h3>;
        },
        ul({ children }) {
          return <ul className="list-none space-y-0.5 mb-2 pl-2">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="list-decimal list-inside space-y-0.5 mb-2 pl-2">{children}</ol>;
        },
        li({ children }) {
          return (
            <li className="text-sm flex gap-2 items-start">
              <span className="text-phobos-green/40 mt-0.5 shrink-0">▸</span>
              <span>{children}</span>
            </li>
          );
        },
        blockquote({ children }) {
          return (
            <blockquote className="border-l-2 border-phobos-green/30 pl-3 my-2 text-muted-foreground/70 italic">
              {children}
            </blockquote>
          );
        },
        strong({ children }) {
          return <strong className="font-semibold text-foreground">{children}</strong>;
        },
        em({ children }) {
          return <em className="italic text-muted-foreground/80">{children}</em>;
        },
        hr() {
          return <hr className="border-border/30 my-3" />;
        },
        table({ children }) {
          return (
            <div className="overflow-x-auto my-2">
              <table className="text-[11px] font-mono border-collapse w-full">{children}</table>
            </div>
          );
        },
        th({ children }) {
          return <th className="border border-border/30 px-2 py-1 bg-muted/40 text-left text-muted-foreground font-semibold">{children}</th>;
        },
        td({ children }) {
          return <td className="border border-border/30 px-2 py-1">{children}</td>;
        },
        a({ href, children }) {
          return <a href={href} target="_blank" rel="noopener noreferrer" className="text-phobos-green/70 underline underline-offset-2 hover:text-phobos-green transition-colors">{children}</a>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
