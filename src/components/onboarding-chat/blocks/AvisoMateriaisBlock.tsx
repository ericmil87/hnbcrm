import { useState } from "react";
import { useMutation } from "convex/react";
import { CheckCircle2, Info } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { mutationErrorMessage } from "@/lib/errors";
import { ModelText } from "../ModelText";
import { BlockCard } from "./BlockCard";
import type { BlockProps } from "./types";

export interface AvisoMateriaisViewProps {
  /** Texto fixo do servidor (aviso de LGPD / transferência internacional). */
  text: string;
  acknowledged: boolean;
  note?: string;
  disabled?: boolean;
  /** Chamada SÓ pelo clique em "Li e entendi". */
  onAck: () => Promise<void>;
}

/** `avisoMateriais` (apresentação): o texto do servidor e o botão de ciência (clique explícito). */
export function AvisoMateriaisView({ text, acknowledged, note, disabled = false, onAck }: AvisoMateriaisViewProps) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = acknowledged || done;

  const ack = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAck();
      setDone(true);
    } catch (err) {
      setError(mutationErrorMessage(err, "Não foi possível registrar. Tente de novo."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <BlockCard title="Aviso sobre materiais" icon={Info} note={note}>
      <ModelText text={text} className="text-sm text-text-primary" />
      {ok ? (
        <p role="status" className="mt-2 flex items-start gap-2 text-sm text-text-secondary">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-semantic-success" aria-hidden="true" />
          Ciência registrada. Já pode enviar materiais.
        </p>
      ) : (
        <div className="mt-2">
          <Button type="button" loading={busy} disabled={disabled || busy} onClick={() => void ack()}>
            Li e entendi
          </Button>
        </div>
      )}
      <div aria-live="polite">{error && <p className="mt-2 text-sm text-semantic-error">{error}</p>}</div>
    </BlockCard>
  );
}

/** Container: `onboardingChat.ackMaterialsNotice` com a org e a sessão da conversa. */
export function AvisoMateriaisBlock({ block, ctx }: BlockProps<"avisoMateriais">) {
  const ack = useMutation(api.onboardingChat.ackMaterialsNotice);
  const organizationId = ctx.organizationId as Id<"organizations"> | null;
  const sessionId = ctx.sessionId as Id<"onboardingSessions"> | null;
  return (
    <AvisoMateriaisView
      text={block.text}
      acknowledged={block.acknowledged}
      note={block.note}
      disabled={!organizationId || !sessionId}
      onAck={async () => {
        if (!organizationId || !sessionId) return;
        await ack({ organizationId, sessionId });
      }}
    />
  );
}
