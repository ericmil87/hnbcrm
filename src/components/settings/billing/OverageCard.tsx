import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { SectionCard } from "@/components/ui/SectionCard";
import { Switch } from "@/components/ui/Switch";
import { attendancesCoveredByCap, type OverageEligibility } from "@/lib/billingPanel";
import { formatCount, formatMoney } from "@/lib/format";

export interface OverageCardViewProps {
  enabled: boolean;
  /** Teto vigente (R$), quando ligado. */
  capBrl: number | null;
  unitBrlCents: number | null;
  eligibility: OverageEligibility;
  canManage: boolean;
  capInput: string;
  capError: string | null;
  /** Tem alteração de teto para salvar (ligado e o valor mudou). */
  capDirty: boolean;
  saving: boolean;
  confirmOpen: boolean;
  confirmTitle: string;
  confirmText: string;
  /** Teto já validado, para mostrar quanto cobre (ou `null`). */
  parsedCapBrl: number | null;
  onCapInputChange: (value: string) => void;
  onToggle: (next: boolean) => void;
  onSaveCap: () => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
}

export function OverageCardView(p: OverageCardViewProps) {
  const locked = !p.eligibility.canEnable || !p.canManage;
  const covered = p.parsedCapBrl !== null ? attendancesCoveredByCap(p.parsedCapBrl, p.unitBrlCents) : null;
  return (
    <SectionCard
      title="Excedente com teto"
      description="O que acontece quando a franquia de atendimentos IA acaba"
      icon={<ShieldAlert size={18} />}
    >
      <div className="space-y-4">
        <Switch
          label="Continuar atendendo com a IA e cobrar o excedente"
          description={
            p.unitBrlCents === null
              ? "Desligado: a IA passa a só sugerir respostas e a equipe envia."
              : `${formatMoney(p.unitBrlCents / 100)} por atendimento além da franquia. Desligado: a IA passa a só sugerir respostas e a equipe envia.`
          }
          checked={p.enabled}
          disabled={locked || p.saving}
          onCheckedChange={p.onToggle}
        />

        {!p.eligibility.canEnable && p.eligibility.reason && (
          <p role="status" className="text-sm text-text-secondary">
            {p.eligibility.reason}
          </p>
        )}
        {p.eligibility.canEnable && !p.canManage && (
          <p className="text-sm text-text-secondary">Peça a um administrador para ligar ou mudar o excedente.</p>
        )}

        {p.eligibility.canEnable && (
          <div className="space-y-2">
            <Input
              id="overage-cap"
              label="Teto do mês (R$)"
              inputMode="numeric"
              className="tabular-nums"
              placeholder="Ex.: 250"
              value={p.capInput}
              disabled={!p.canManage || p.saving}
              error={p.capError ?? undefined}
              onChange={(e) => p.onCapInputChange(e.target.value)}
            />
            {covered !== null && (
              <p className="text-caption tabular-nums text-text-muted">
                Com esse teto, vão até {formatCount(covered)} atendimentos a mais por mês.
              </p>
            )}
            {p.enabled && p.capBrl !== null && (
              <p className="text-caption tabular-nums text-text-muted">
                Excedente ligado com teto de {formatMoney(p.capBrl, "BRL", { fractionDigits: 0 })} por mês.
              </p>
            )}
            {p.enabled && p.capDirty && p.canManage && (
              <Button variant="primary" loading={p.saving} onClick={p.onSaveCap}>
                Salvar teto
              </Button>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={p.confirmOpen}
        onClose={p.onCancelConfirm}
        onConfirm={p.onConfirm}
        title={p.confirmTitle}
        description={p.confirmText}
        confirmLabel="Aceitar e salvar"
      />
    </SectionCard>
  );
}
