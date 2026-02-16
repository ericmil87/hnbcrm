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
    <div className="relative group rounded-lg overflow-hidden border border-border">
      <div className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-border">
        <span className="text-xs text-text-muted font-mono">{language}</span>
        <button
          onClick={handleCopy}
          className="text-text-muted hover:text-text-secondary transition-colors p-1"
          aria-label="Copiar codigo"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre className="bg-[#0d1117] p-4 overflow-x-auto">
        <code className="text-sm font-mono text-text-secondary whitespace-pre">
          {children.trim()}
        </code>
      </pre>
    </div>
  );
}
