import { useState } from "react";
import { Copy, Check } from "lucide-react";

export function CodeBlock({ children, language = "bash" }: { children: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(children.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group rounded-lg overflow-hidden border border-border-strong">
      <div className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-white/10">
        <span className="text-xs text-white/60 font-mono">{language}</span>
        <button
          onClick={handleCopy}
          className="text-white/60 hover:text-white transition-colors p-2 -m-1 min-w-[44px] min-h-[44px] inline-flex items-center justify-center"
          aria-label="Copiar código"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre className="bg-[#0d1117] p-4 overflow-x-auto">
        <code className="text-sm font-mono text-white/85 whitespace-pre">
          {children.trim()}
        </code>
      </pre>
    </div>
  );
}
