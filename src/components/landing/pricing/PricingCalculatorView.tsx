import { Link } from "react-router";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { formatCount, formatMoney } from "@/lib/format";
import type { PricingLineId, PricingOption, PricingResult } from "@/lib/pricing";
import { PLANS } from "../../../../convex/lib/plans";
import { CTA_LABEL } from "./pricingCopy";

export interface CalculatorValue {
  channels: number;
  attendances: number;
  byo: boolean;
  multiUnit: boolean;
  units: number;
  groups: boolean;
  teamModules: boolean;
}

export interface CalculatorExample {
  id: string;
  label: string;
}

interface PricingCalculatorViewProps {
  value: CalculatorValue;
  result: PricingResult;
  examples: readonly CalculatorExample[];
  onChange: (patch: Partial<CalculatorValue>) => void;
  onPickExample: (id: string) => void;
}

const ATTENDANCE_SHORTCUTS = [100, 300, 1000, 2500] as const;

const LINE_LABEL: Record<PricingLineId, string> = {
  plan: "Plano",
  extraChannels: "Canais extra",
  groupsAddon: "Add-on Grupos",
  overage: "Excedente estimado",
  annualDiscount: "Desconto do plano anual",
};

const money = (v: number) => formatMoney(v, "BRL", { fractionDigits: v % 1 === 0 ? 0 : 2 });

function parseCount(raw: string, min: number, max: number): number {
  const n = Number.parseInt(raw.replace(/\D/g, ""), 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function lineText(id: PricingLineId, quantity: number, plan: PricingOption["plan"]): string {
  if (id === "plan") return quantity > 1 ? `${PLANS[plan].label} (${quantity} unidades)` : PLANS[plan].label;
  if (id === "extraChannels" || id === "overage") return `${LINE_LABEL[id]} (${formatCount(quantity)})`;
  return LINE_LABEL[id];
}

function AlternativeRow({ option }: { option: PricingOption }) {
  return (
    <li className="flex items-center justify-between gap-3 text-sm text-text-secondary">
      <span>{PLANS[option.plan].label}</span>
      <span className="tabular-nums">{money(option.totalMonthlyBrl)}/mês</span>
    </li>
  );
}

export function PricingCalculatorView({
  value,
  result,
  examples,
  onChange,
  onPickExample,
}: PricingCalculatorViewProps) {
  const perChannel = value.channels > 1 ? result.totalMonthlyBrl / value.channels : null;
  const planLabel = PLANS[result.plan].label;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-5">
        <div>
          <p className="text-sm font-medium text-text-secondary mb-2">Exemplos de um toque</p>
          <div className="flex flex-wrap gap-2">
            {examples.map((ex) => (
              <button
                key={ex.id}
                type="button"
                onClick={() => onPickExample(ex.id)}
                className="min-h-11 rounded-full border border-border bg-surface-raised px-4 text-sm text-text-primary hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {ex.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p id="calc-channels-label" className="text-sm font-medium text-text-secondary mb-2">
            Canais (números de WhatsApp, Instagram, Messenger)
          </p>
          <div className="flex items-center gap-2" role="group" aria-labelledby="calc-channels-label">
            <Button
              variant="secondary"
              iconOnly
              aria-label="Diminuir canais"
              disabled={value.channels <= 1}
              onClick={() => onChange({ channels: value.channels - 1 })}
            >
              <Minus size={16} />
            </Button>
            <Input
              id="calc-channels"
              aria-labelledby="calc-channels-label"
              inputMode="numeric"
              className="text-center tabular-nums"
              value={String(value.channels)}
              onChange={(e) => onChange({ channels: parseCount(e.target.value, 1, 30) })}
            />
            <Button
              variant="secondary"
              iconOnly
              aria-label="Aumentar canais"
              disabled={value.channels >= 30}
              onClick={() => onChange({ channels: value.channels + 1 })}
            >
              <Plus size={16} />
            </Button>
          </div>
        </div>

        <div>
          <Input
            id="calc-attendances"
            label="Atendimentos IA por mês"
            inputMode="numeric"
            className="tabular-nums"
            value={String(value.attendances)}
            onChange={(e) => onChange({ attendances: parseCount(e.target.value, 0, 20000) })}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {ATTENDANCE_SHORTCUTS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={value.attendances === n}
                onClick={() => onChange({ attendances: n })}
                className="min-h-11 rounded-full border border-border px-4 text-sm tabular-nums text-text-secondary hover:bg-surface-overlay aria-pressed:border-brand-500 aria-pressed:bg-brand-500/10 aria-pressed:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {formatCount(n)}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <Switch
            label="Tenho chave de IA própria"
            description="O excedente fica mais barato nos planos a partir do Profissional."
            checked={value.byo}
            onCheckedChange={(byo) => onChange({ byo })}
          />
          <Switch
            label="Preciso de grupos de WhatsApp"
            checked={value.groups}
            onCheckedChange={(groups) => onChange({ groups })}
          />
          <Switch
            label="Preciso de setores, tradução ou API"
            checked={value.teamModules}
            onCheckedChange={(teamModules) => onChange({ teamModules })}
          />
          <Switch
            label="Tenho várias unidades (filiais, casas, hotéis)"
            checked={value.multiUnit}
            onCheckedChange={(multiUnit) => onChange({ multiUnit })}
          />
          {value.multiUnit && (
            <Input
              id="calc-units"
              label="Quantas unidades?"
              inputMode="numeric"
              className="tabular-nums"
              value={String(value.units)}
              onChange={(e) => onChange({ units: parseCount(e.target.value, 2, 50) })}
            />
          )}
        </div>
      </div>

      <div className="rounded-card border border-brand-500 bg-brand-500/10 p-4 md:p-6" role="status" aria-live="polite">
        <p className="text-sm text-text-secondary">Plano recomendado</p>
        <p className="text-xl font-bold text-text-primary">
          {planLabel}
          <span className="ml-2 text-sm font-normal text-text-secondary">
            {result.overageAttendances > 0 ? "com excedente" : "dentro da franquia"}
          </span>
        </p>
        <p className="mt-2 text-4xl font-bold tabular-nums text-text-primary">
          {money(result.totalMonthlyBrl)}
          <span className="text-base font-normal text-text-secondary">/mês</span>
        </p>
        {perChannel !== null && (
          <p className="text-sm text-text-secondary tabular-nums">
            Equivale a {money(perChannel)} por canal
          </p>
        )}

        <ul className="mt-4 space-y-1.5 border-t border-border pt-4">
          {result.lines.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-3 text-sm text-text-primary">
              <span>{lineText(l.id, l.quantity, result.plan)}</span>
              <span className="tabular-nums">{money(l.amountBrl)}</span>
            </li>
          ))}
        </ul>

        {result.upgradePlan !== null && result.upgradeAtAttendances !== null && (
          <p className="mt-4 text-sm text-text-secondary tabular-nums">
            Se passar de {formatCount(result.upgradeAtAttendances)} atendimentos por mês, o plano{" "}
            {PLANS[result.upgradePlan].label} passa a sair mais barato.
          </p>
        )}

        {result.alternatives.length > 0 && (
          <div className="mt-4 border-t border-border pt-4">
            <p className="text-sm font-medium text-text-secondary mb-2">Outras opções</p>
            <ul className="space-y-1.5">
              {result.alternatives.slice(0, 2).map((o) => (
                <AlternativeRow key={o.plan} option={o} />
              ))}
            </ul>
          </div>
        )}

        <p className="mt-4 text-caption text-text-muted">
          O excedente só é cobrado se você ligar, com o teto que escolher. Valor estimado.
        </p>
        <Link to="/entrar" className="mt-4 block">
          <Button variant="primary" size="lg" className="w-full">
            {CTA_LABEL}
          </Button>
        </Link>
      </div>
    </div>
  );
}
