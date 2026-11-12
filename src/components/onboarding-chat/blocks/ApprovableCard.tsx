import { useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CARD_PURPOSE, type OnboardingBlock } from "../../../../convex/lib/onboardingBlocks";
import type { DraftCardKind } from "../../../../convex/lib/onboardingRoadmap";
import { BlockCard, type BlockCardProps } from "./BlockCard";

/** "Para que serve" do cartão: a frase do servidor, ou a fixa para mensagens antigas que não a trazem. */
export function purposeOf(block: Pick<OnboardingBlock, "kind"> & { purpose?: string }): string | undefined {
  if (typeof block.purpose === "string" && block.purpose.trim()) return block.purpose;
  return (CARD_PURPOSE as Record<string, string>)[block.kind as DraftCardKind];
}

/** Estado de aprovação de um cartão (calculado AO VIVO por quem monta a View). */
export interface ApprovalProps {
  approved: boolean;
  /** Assinatura do conteúdo que a pessoa vê agora (vai no `approve`). */
  sig?: string;
  /** Um turno está em andamento: o clique não se perde (a conversa guarda o evento e envia quando ociosa). */
  busy?: boolean;
  /** Ausente (prévia compacta do painel): só o selo, sem botão. */
  onApprove?: (sig?: string) => void;
}

export function ApprovalBadge({ approved }: { approved: boolean }) {
  return approved ? (
    <Badge variant="success" className="gap-1">
      <Check className="size-3" aria-hidden="true" />
      Aprovado
    </Badge>
  ) : (
    <Badge variant="warning">Falta conferir</Badge>
  );
}

export interface ApprovableCardProps extends Omit<BlockCardProps, "footer" | "badge"> {
  approval?: ApprovalProps;
  compact?: boolean;
  /** Formulário de ajuste aberto (ele traz as próprias ações). */
  formOpen?: boolean;
  /** Botão "Ajustar" (ausente = nada a ajustar neste momento). */
  onAdjust?: () => void;
  extraActions?: ReactNode;
}

/**
 * Cartão do rascunho com "Está bom, seguir" + "Ajustar". Aprovado (ao vivo):
 * recolhe para título + selo + "Ver"/"Ajustar". Na prévia compacta do painel só
 * mostra o selo. Sem `approval` é o cartão de sempre, com "Ajustar".
 */
export function ApprovableCard({ approval, compact, formOpen = false, onAdjust, extraActions, children, ...card }: ApprovableCardProps) {
  const [expanded, setExpanded] = useState(false);
  const badge = approval ? <ApprovalBadge approved={approval.approved} /> : undefined;
  const collapsed = !!approval?.approved && !compact && !expanded && !formOpen;

  if (collapsed) {
    return (
      <BlockCard
        title={card.title}
        icon={card.icon}
        badge={badge}
        className={card.className}
        footer={
          <>
            <Button type="button" size="sm" variant="ghost" aria-expanded={false} onClick={() => setExpanded(true)}>
              <ChevronDown className="size-3.5" aria-hidden="true" />
              Ver
            </Button>
            {onAdjust && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setExpanded(true);
                  onAdjust();
                }}
              >
                <SlidersHorizontal className="size-3.5" aria-hidden="true" />
                Ajustar
              </Button>
            )}
          </>
        }
      />
    );
  }

  const canApprove = !!approval && !compact && !approval.approved && !!approval.onApprove;
  const footer = formOpen ? null : (
    <>
      {canApprove && (
        <Button type="button" onClick={() => approval?.onApprove?.(approval.sig)}>
          <Check className="size-4" aria-hidden="true" />
          Está bom, seguir
        </Button>
      )}
      {onAdjust && (
        <Button type="button" size={canApprove ? "md" : "sm"} variant="secondary" onClick={onAdjust}>
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          Ajustar
        </Button>
      )}
      {extraActions}
      {approval?.approved && expanded && !compact && (
        <Button type="button" size="sm" variant="ghost" aria-expanded onClick={() => setExpanded(false)}>
          <ChevronUp className="size-3.5" aria-hidden="true" />
          Recolher
        </Button>
      )}
    </>
  );
  const hasFooter = !formOpen && (canApprove || !!onAdjust || !!extraActions || (approval?.approved && expanded && !compact));
  return (
    <BlockCard {...card} badge={badge} footer={hasFooter ? footer : undefined}>
      {children}
    </BlockCard>
  );
}
