import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Copy, Check, Eye, EyeOff, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

interface ApiKeyRevealModalProps {
  open: boolean;
  onClose: () => void;
  apiKey: string;
}

export function ApiKeyRevealModal({ open, onClose, apiKey }: ApiKeyRevealModalProps) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const maskedKey = apiKey.slice(0, 8) + "\u2022".repeat(32) + apiKey.slice(-4);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    toast.success("Chave copiada!");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal open={open} onClose={onClose} title="Chave API Criada">
      <div className="space-y-5">
        {/* Key display */}
        <div className="relative">
          <div className="flex items-center gap-2 bg-surface-sunken border border-border rounded-lg p-3">
            <code className="flex-1 text-sm font-mono text-text-primary break-all select-all">
              {revealed ? apiKey : maskedKey}
            </code>
            <button
              onClick={() => setRevealed(!revealed)}
              className="flex-shrink-0 p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors"
              aria-label={revealed ? "Ocultar chave" : "Revelar chave"}
            >
              {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        {/* Copy button */}
        <Button
          variant="primary"
          size="lg"
          onClick={handleCopy}
          className="w-full"
        >
          {copied ? <Check size={18} /> : <Copy size={18} />}
          {copied ? "Copiada!" : "Copiar Chave"}
        </Button>

        {/* Security warning */}
        <div className="flex gap-3 bg-semantic-warning/5 border border-semantic-warning/20 rounded-lg p-3">
          <ShieldAlert size={20} className="flex-shrink-0 text-semantic-warning mt-0.5" />
          <p className="text-sm text-text-secondary leading-relaxed">
            Salve esta chave em local seguro. Você não poderá vê-la novamente.
          </p>
        </div>

        {/* Close button */}
        <Button
          variant="secondary"
          onClick={onClose}
          className="w-full"
        >
          Fechar
        </Button>
      </div>
    </Modal>
  );
}
