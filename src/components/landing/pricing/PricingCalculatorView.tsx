import { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { Input } from "@/components/ui/Input";
import { useCountUp } from "@/hooks/useCountUp";
import { startHref } from "@/lib/onboardingEntry";
import { formatCount, formatMoney } from "@/lib/format";
import type { BillingCycle, PricingLineId, PricingOption, PricingResult } from "@/lib/pricing";
import {
  ATTENDANCE_MARKS,
  SLIDER_MAX,
  attendancesToSlider,
  channelOverflowPlan,
  perPersonBrl,
  sliderToAttendances,
  valueToInput,
  type CalculatorValue,
} from "@/lib/pricingConversation";
import { planDisplay } from "@/lib/pricingCatalog";
import { cn } from "@/lib/utils";
import { EXTRA_CHANNEL_BRL, PLANS } from "../../../../convex/lib/plans";
import { CTA_LABEL } from "./pricingCopy";

export type { CalculatorValue };

export interface CalculatorExample {
  id: string;
  label: string;
}

interface PricingCalculatorViewProps {
  value: CalculatorValue;
  result: PricingResult;
  /** Atalhos de um toque (opcional; só na vista completa). */
  examples?: readonly CalculatorExample[];
  onChange: (patch: Partial<CalculatorValue>) => void;
  onPickExample?: (id: string) => void;
  cycle?: BillingCycle;
  /** `compact`: só as perguntas 1 e 2, a frase e o botão (resumo da landing). */
  variant?: "full" | "compact";
  /** Destino do link "Ajustar mais opções" (variante compacta). */
  fullTableHref?: string;
}

const LINE_LABEL: Record<PricingLineId, string> = {
  plan: "Plano",
  extraChannels: "Canais extra",
  groupsAddon: "Add-on Grupos",
  overage: "Excedente estimado",
  annualDiscount: "Desconto do plano anual",
};

const ATTENDANCE_MAX = 20000;
const CHANNELS_MAX = 30;
const UNITS_MIN = 2;
const UNITS_MAX = 50;
const SETTLE_MS = 500;

const money = (v: number) => formatMoney(v, "BRL", { fractionDigits: v % 1 === 0 ? 0 : 2 });

function parseDigits(raw: string, min: number, max: number): number | null {
  const n = Number.parseInt(raw.replace(/\D/g, ""), 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** Valor que só muda depois de `ms` sem novas mudanças (anúncio para leitor de tela). */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

function lineText(id: PricingLineId, quantity: number, plan: PricingOption["plan"]): string {
  if (id === "plan") return quantity > 1 ? `${PLANS[plan].label} (${quantity} unidades)` : PLANS[plan].label;
  if (id === "extraChannels" || id === "overage") return `${LINE_LABEL[id]} (${formatCount(quantity)})`;
  return LINE_LABEL[id];
}

interface StepperProps {
  label: string;
  decreaseLabel: string;
  increaseLabel: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}

function CountStepper({ label, decreaseLabel, increaseLabel, value, min, max, onChange }: StepperProps) {
  return (
    <div className="flex items-center gap-3" role="group" aria-label={label}>
      <Button
        variant="secondary"
        size="lg"
        iconOnly
        aria-label={decreaseLabel}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        <Minus size={18} />
      </Button>
      <span className="min-w-12 text-center text-2xl font-bold tabular-nums text-text-primary">
        {value}
      </span>
      <Button
        variant="secondary"
        size="lg"
        iconOnly
        aria-label={increaseLabel}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        <Plus size={18} />
      </Button>
    </div>
  );
}

interface PeopleQuestionProps {
  value: number;
  onChange: (n: number) => void;
}

/**
 * Pergunta 1: slider com marcas + campo numérico. O texto do campo é estado
 * local (aceita ficar vazio); só números válidos sobem a cada tecla, o texto é
 * normalizado ao sair e, vazio, mostra a dica sem inventar um valor.
 */
function PeopleQuestion({ value, onChange }: PeopleQuestionProps) {
  const uid = useId();
  const labelId = `${uid}-label`;
  const fieldId = `${uid}-field`;
  const [text, setText] = useState(String(value));
  const [emptyHint, setEmptyHint] = useState(false);

  useEffect(() => {
    setText((t) => (t !== "" && parseDigits(t, 0, ATTENDANCE_MAX) === value ? t : String(value)));
  }, [value]);

  const last = ATTENDANCE_MARKS[ATTENDANCE_MARKS.length - 1];
  const position = attendancesToSlider(value);
  const maxPosition = SLIDER_MAX;
  const valueText = value >= last ? `${formatCount(last)} pessoas ou mais` : `${formatCount(value)} pessoas`;

  return (
    <div>
      <p id={labelId} className="text-lg font-semibold text-text-primary">
        Quantas pessoas diferentes falam com você no WhatsApp por mês?
      </p>
      <p className="mt-1 text-sm text-text-secondary">
        Conte clientes novos e os que voltam a falar. Quem fala várias vezes conta uma vez.
      </p>

      <div className="mt-3">
        <input
          type="range"
          min={0}
          max={SLIDER_MAX}
          step={1}
          value={position}
          aria-labelledby={labelId}
          aria-valuetext={valueText}
          onChange={(e) => {
            setEmptyHint(false);
            onChange(sliderToAttendances(Number(e.target.value)));
          }}
          className="h-11 w-full cursor-pointer accent-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded-full"
        />
        <div className="relative h-11">
          {ATTENDANCE_MARKS.map((mark, i) => {
            const isLast = i === ATTENDANCE_MARKS.length - 1;
            return (
              <button
                key={mark}
                type="button"
                aria-label={`${formatCount(mark)} pessoas${isLast ? " ou mais" : ""}`}
                onClick={() => {
                  setEmptyHint(false);
                  onChange(mark);
                }}
                className={cn(
                  "absolute top-0 min-h-11 min-w-11 px-1 text-sm tabular-nums text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded-field",
                  i === 0 && "left-0 text-left",
                  isLast && "right-0 text-right",
                  !isLast && i > 0 && "-translate-x-1/2 text-center",
                  // Marcas vizinhas se sobrepõem em telas estreitas: lá ficam só as pontas e a do meio.
                  !isLast && i > 0 && i % 2 === 1 && "hidden sm:block",
                )}
                style={!isLast && i > 0 ? { left: `${(attendancesToSlider(mark) / maxPosition) * 100}%` } : undefined}
              >
                {formatCount(mark)}
                {isLast ? "+" : ""}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-2 flex items-start gap-2">
        <div className="w-36">
          <Input
            id={fieldId}
            label="Ou digite"
            inputMode="numeric"
            className="tabular-nums"
            value={text}
            aria-invalid={emptyHint || undefined}
            error={emptyHint ? "Digite um número ou use a barra." : undefined}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "");
              setText(digits);
              setEmptyHint(false);
              const n = parseDigits(digits, 0, ATTENDANCE_MAX);
              if (n === null) return;
              // Texto que diverge do valor usado no cálculo (teto, zeros à esquerda) é corrigido na hora.
              if (String(n) !== digits) setText(String(n));
              onChange(n);
            }}
            onBlur={() => {
              const n = parseDigits(text, 0, ATTENDANCE_MAX);
              if (n === null) {
                setEmptyHint(true);
                return;
              }
              setText(String(n));
              if (n !== value) onChange(n);
            }}
          />
        </div>
        <span className="pt-[34px] text-sm text-text-secondary">pessoas</span>
      </div>
    </div>
  );
}

interface ChipProps {
  pressed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function Chip({ pressed, onToggle, children }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className="min-h-11 rounded-full border border-border bg-surface-raised px-4 text-sm text-text-secondary hover:bg-surface-overlay aria-pressed:border-brand-500 aria-pressed:bg-brand-500/10 aria-pressed:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {children}
    </button>
  );
}

export function PricingCalculatorView({
  value,
  result,
  examples = [],
  onChange,
  onPickExample,
  cycle = "monthly",
  variant = "full",
  fullTableHref = "/precos#calculadora",
}: PricingCalculatorViewProps) {
  const compact = variant === "compact";
  const optionsId = `${useId()}-options`;
  const planLabel = PLANS[result.plan].label;
  const animatedTotal = useCountUp(result.totalMonthlyBrl);
  const totalText =
    animatedTotal === result.totalMonthlyBrl ? money(result.totalMonthlyBrl) : money(Math.round(animatedTotal));

  const perPerson = perPersonBrl(result, value.attendances);
  const perDay =
    perPerson === null && result.plan === "essencial" && cycle === "monthly"
      ? planDisplay("essencial", cycle).perDayBrl
      : null;
  const perDayCompact =
    perDay ?? (cycle === "monthly" && result.plan !== "empresa" ? Math.round(result.totalMonthlyBrl / 30) : null);
  const overflowPlan = channelOverflowPlan(valueToInput(value, cycle), result);
  const hasUpgrade = result.upgradePlan !== null && result.upgradeAtAttendances !== null;
  const isEmpresa = result.plan === "empresa";

  const announcement = useSettled(
    `Plano sugerido: ${planLabel}, ${money(result.totalMonthlyBrl)} por mês${
      result.overageAttendances > 0 ? `, já com excedente estimado de ${money(result.overageBrl)}` : ""
    }${cycle === "annual" ? ", no plano anual" : ""}.`,
    SETTLE_MS,
  );

  const questions = (
    <>
      <PeopleQuestion value={value.attendances} onChange={(attendances) => onChange({ attendances })} />
      <div>
        <p className="text-lg font-semibold text-text-primary">Em quantos números de WhatsApp?</p>
        <div className="mt-3">
          <CountStepper
            label="Números de WhatsApp"
            decreaseLabel="Diminuir números de WhatsApp"
            increaseLabel="Aumentar números de WhatsApp"
            value={value.channels}
            min={1}
            max={CHANNELS_MAX}
            onChange={(channels) => onChange({ channels })}
          />
        </div>
        <p className="mt-2 text-sm text-text-secondary tabular-nums">
          Número extra: {money(EXTRA_CHANNEL_BRL)} por mês.
        </p>
        {overflowPlan !== null && (
          <p className="mt-1 text-sm text-semantic-warning tabular-nums">
            Com {value.channels} números, o {PLANS[overflowPlan].label} não comporta. Mostramos o plano que comporta.
          </p>
        )}
      </div>
    </>
  );

  return (
    <div className={compact ? "space-y-6 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start lg:gap-8 lg:space-y-0" : "space-y-6"}>
      {!compact && examples.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium text-text-secondary">Ou comece por um exemplo</p>
          <div className="flex flex-wrap gap-2">
            {examples.map((ex) => (
              <button
                key={ex.id}
                type="button"
                onClick={() => onPickExample?.(ex.id)}
                className="min-h-11 rounded-full border border-border bg-surface-raised px-4 text-sm text-text-primary hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {ex.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {compact ? <div className="space-y-6">{questions}</div> : questions}

      {!compact && (
        <div>
          <p id={optionsId} className="text-lg font-semibold text-text-primary">
            Precisa de algum destes?
          </p>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-labelledby={optionsId}>
            <Chip pressed={value.groups} onToggle={() => onChange({ groups: !value.groups })}>
              Grupos de WhatsApp
            </Chip>
            <Chip pressed={value.teamModules} onToggle={() => onChange({ teamModules: !value.teamModules })}>
              Departamentos, tradução ou API
            </Chip>
            <Chip pressed={value.multiUnit} onToggle={() => onChange({ multiUnit: !value.multiUnit })}>
              Várias unidades (filiais, casas, hotéis)
            </Chip>
            <Chip pressed={value.byo} onToggle={() => onChange({ byo: !value.byo })}>
              Tenho chave de IA própria
            </Chip>
          </div>
          {value.byo && (
            <p className="mt-2 text-sm text-text-secondary">O excedente fica mais barato do {PLANS.profissional.label} em diante.</p>
          )}
          {value.multiUnit && (
            <div className="mt-4">
              <p className="mb-2 text-sm font-medium text-text-secondary">Quantas unidades?</p>
              <CountStepper
                label="Unidades"
                decreaseLabel="Diminuir unidades"
                increaseLabel="Aumentar unidades"
                value={value.units}
                min={UNITS_MIN}
                max={UNITS_MAX}
                onChange={(units) => onChange({ units })}
              />
            </div>
          )}
        </div>
      )}

      {!compact && (
        <div>
          <CollapsibleSection title="Ver a conta">
            <ul className="space-y-1.5 pb-3">
              {result.lines.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 text-sm text-text-primary">
                  <span>{lineText(l.id, l.quantity, result.plan)}</span>
                  <span className="tabular-nums">{money(l.amountBrl)}</span>
                </li>
              ))}
            </ul>
          </CollapsibleSection>
          {result.alternatives.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-text-secondary">
              {result.alternatives.slice(0, 2).map((o) => (
                <li key={o.plan} className="tabular-nums">
                  Também serve: {PLANS[o.plan].label} · {money(o.totalMonthlyBrl)}/mês
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div
        data-testid="calculator-result"
        className={cn(
          "rounded-card border border-brand-500 bg-surface-raised p-4 md:p-5",
          !compact && "sticky bottom-0 z-10 shadow-elevated pb-[max(1rem,env(safe-area-inset-bottom))] md:static md:pb-5 md:shadow-none",
        )}
      >
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>

        {compact ? (
          <div aria-hidden="true">
            <p className="text-caption font-semibold uppercase tracking-wide text-brand-600">Plano recomendado</p>
            <p className="mt-1 font-display text-xl font-bold text-text-primary">{planLabel}</p>
            <p className="mt-1 text-text-primary">
              <span data-testid="calculator-total" className="text-4xl font-bold tabular-nums">
                {totalText}
              </span>
              <span className="text-base text-text-secondary">/mês</span>
            </p>
            {result.overageAttendances > 0 && (
              <p className="mt-1 text-sm text-text-secondary tabular-nums">
                Já com o excedente estimado de {money(result.overageBrl)}.
              </p>
            )}
            {perPerson !== null && (
              <p className="mt-1 text-sm text-text-secondary tabular-nums">
                Dá {money(perPerson)} por pessoa atendida, usando a franquia inteira.
              </p>
            )}
            {perDayCompact !== null && (
              <p className="mt-1 text-sm text-text-secondary tabular-nums">Cerca de {money(perDayCompact)} por dia.</p>
            )}
          </div>
        ) : (
          <div aria-hidden="true">
            <p className="text-base text-text-primary md:text-lg">
              Para você:{" "}
              <strong className="font-bold">
                {planLabel},{" "}
                <span data-testid="calculator-total" className="tabular-nums">
                  {totalText}
                </span>
                /mês
              </strong>
              {result.overageAttendances > 0
                ? `, já com o excedente estimado de ${money(result.overageBrl)}.`
                : "."}
            </p>
            {perPerson !== null && (
              <p className="mt-1 text-sm text-text-secondary tabular-nums">
                Dá {money(perPerson)} por pessoa atendida, usando a franquia inteira.
              </p>
            )}
            {perDay !== null && (
              <p className="mt-1 text-sm text-text-secondary tabular-nums">Cerca de {money(perDay)} por dia.</p>
            )}
            {!compact && hasUpgrade && (
              <p className="mt-2 text-sm text-text-secondary tabular-nums">
                Se passar de {formatCount(result.upgradeAtAttendances ?? 0)} pessoas por mês, o{" "}
                <strong>{result.upgradePlan ? PLANS[result.upgradePlan].label : ""}</strong> passa a sair mais barato.
              </p>
            )}
          </div>
        )}

        <Link to={startHref(result.plan)} className="mt-3 block">
          <Button variant={isEmpresa ? "secondary" : "primary"} size="lg" className="w-full">
            {isEmpresa ? "Falar com a gente" : CTA_LABEL}
          </Button>
        </Link>

        {compact ? (
          <p className="mt-3 text-center text-sm">
            <Link to={fullTableHref} className="inline-flex min-h-11 items-center text-brand-500 underline underline-offset-2 hover:text-brand-400">
              Ajustar mais opções
            </Link>
          </p>
        ) : (
          <p className="mt-3 text-caption text-text-muted">
            O excedente só é cobrado se você ligar, com o teto que escolher. Valor estimado.
          </p>
        )}
      </div>
    </div>
  );
}
