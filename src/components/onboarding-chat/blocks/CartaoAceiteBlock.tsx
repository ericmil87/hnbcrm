import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { mutationErrorMessage } from "@/lib/errors";
import { AI_LGPD_ACK_LABEL } from "@/lib/aiLgpdText";
import { AiLgpdParagraphs } from "@/components/settings/ai/AiLgpdParagraphs";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

export interface CartaoAceiteViewProps {
  /** IA já ativa (bloco do servidor ou status ao vivo). */
  active: boolean;
  note?: string;
  /** Sem organização/sessão: o botão fica desligado. */
  disabled?: boolean;
  /** Chamada SÓ pelo clique em "Ativar IA", com a caixa de confirmação marcada pela pessoa. */
  onAccept: () => Promise<void>;
}

/**
 * `cartaoAceite` (apresentação): mostra o texto completo do aceite de IA/LGPD
 * (o mesmo da tela de IA), uma caixa DESMARCADA e o botão "Ativar IA". Nada é
 * aceito ao montar nem sem o clique; depois, mostra o estado ativo.
 */
export function CartaoAceiteView({ active, note, disabled = false, onAccept }: CartaoAceiteViewProps) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (active || done) {
    return (
      <BlockCard title="IA ativa" icon={ShieldCheck} note={note}>
        <p role="status" className="flex items-start gap-2 text-sm text-text-primary">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-semantic-success" aria-hidden="true" />
          A IA está ativa na sua organização. Reconhecimento LGPD registrado.
        </p>
      </BlockCard>
    );
  }

  const accept = async () => {
    if (!checked) return;
    setBusy(true);
    setError(null);
    try {
      await onAccept();
      setDone(true);
    } catch (err) {
      setError(mutationErrorMessage(err, "Não foi possível ativar a IA. Tente de novo."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <BlockCard title="Ativar a IA" icon={ShieldCheck} note={note}>
      <div className="space-y-2">
        <AiLgpdParagraphs />
        <Checkbox
          containerClassName="min-h-11 items-center"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          disabled={disabled || busy}
          label={AI_LGPD_ACK_LABEL}
        />
        <Button type="button" loading={busy} disabled={disabled || !checked || busy} onClick={() => void accept()}>
          Ativar IA
        </Button>
        <div aria-live="polite">{error && <p className="text-sm text-semantic-error">{error}</p>}</div>
      </div>
    </BlockCard>
  );
}

/** Container: status ao vivo e `aiSettings.setAiEnabled` (a mesma mutation da tela de IA). */
export function CartaoAceiteBlock({ block, ctx }: BlockProps<"cartaoAceite">) {
  const organizationId = ctx.organizationId as Id<"organizations"> | null;
  const status = useQuery(api.aiSettings.getAiStatus, organizationId ? { organizationId } : "skip");
  const setAiEnabled = useMutation(api.aiSettings.setAiEnabled);
  return (
    <CartaoAceiteView
      active={block.aiActive || status?.active === true}
      note={block.note}
      disabled={!organizationId}
      onAccept={async () => {
        if (!organizationId) return;
        await setAiEnabled({ organizationId, enabled: true, lgpdAck: true });
      }}
    />
  );
}
