import { Link } from "react-router";
import { ArrowRight, LayoutDashboard } from "lucide-react";
import { Button, buttonClassName } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

export interface NextStepBarProps {
  /** Rótulo do botão (`nextStepLabel` do roteiro): o que fazer agora. */
  label: string;
  /** Toque: rola até o cartão do passo (se é o mais recente) ou pede o passo de novo. */
  onPress?: () => void;
  /** Passo final: um link (ex.: "Abrir o meu CRM" → `/app`). */
  href?: string;
  /** Desligado durante um turno (o evento espera a conversa ficar ociosa). */
  disabled?: boolean;
  className?: string;
}

/**
 * Barra do próximo passo, SEMPRE visível acima do campo de mensagem (e no
 * rodapé do painel "Sua operação"): a pessoa leiga nunca fica sem saber o que
 * fazer agora. Um botão principal só; nada aqui chama a IA (é um evento do
 * roteiro, que não falha por limite de uso).
 */
export function NextStepBar({ label, onPress, href, disabled = false, className }: NextStepBarProps) {
  return (
    <div role="group" aria-label="Próximo passo" className={cn("px-2 pt-2", className)}>
      {href ? (
        <Link to={href} className={cn(buttonClassName("primary", "lg"), "min-h-11 w-full")}>
          <LayoutDashboard className="size-4" aria-hidden="true" />
          {label}
        </Link>
      ) : (
        <Button type="button" size="lg" className="w-full" disabled={disabled} onClick={onPress}>
          {label}
          <ArrowRight className="size-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
