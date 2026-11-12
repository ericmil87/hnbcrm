import { useMemo, useState } from "react";
import { calculatePricing, type BillingCycle } from "@/lib/pricing";
import { valueToInput } from "@/lib/pricingConversation";
import { PricingCalculatorView, type CalculatorExample, type CalculatorValue } from "./PricingCalculatorView";

const EXAMPLES: readonly (CalculatorExample & { value: CalculatorValue })[] = [
  {
    id: "corretor",
    label: "Corretor autônomo",
    value: { channels: 1, attendances: 100, byo: false, multiUnit: false, units: 2, groups: false, teamModules: false },
  },
  {
    id: "clinica",
    label: "Clínica",
    value: { channels: 3, attendances: 800, byo: false, multiUnit: false, units: 2, groups: false, teamModules: false },
  },
  {
    id: "imobiliaria",
    label: "Imobiliária com 10 corretores",
    value: { channels: 10, attendances: 2000, byo: false, multiUnit: false, units: 2, groups: false, teamModules: false },
  },
  {
    id: "rede4",
    label: "Rede com 4 unidades",
    value: { channels: 4, attendances: 2000, byo: false, multiUnit: true, units: 4, groups: false, teamModules: false },
  },
  {
    id: "rede11",
    label: "Rede com 11 unidades",
    value: { channels: 11, attendances: 5000, byo: false, multiUnit: true, units: 11, groups: false, teamModules: false },
  },
];

const INITIAL: CalculatorValue = EXAMPLES[0].value;

interface PricingCalculatorProps {
  cycle: BillingCycle;
  variant?: "full" | "compact";
  fullTableHref?: string;
}

export function PricingCalculator({ cycle, variant = "full", fullTableHref }: PricingCalculatorProps) {
  const [value, setValue] = useState<CalculatorValue>(INITIAL);

  const result = useMemo(() => calculatePricing(valueToInput(value, cycle)), [value, cycle]);

  return (
    <PricingCalculatorView
      value={value}
      result={result}
      cycle={cycle}
      variant={variant}
      fullTableHref={fullTableHref}
      examples={EXAMPLES}
      onChange={(patch) => setValue((v) => ({ ...v, ...patch }))}
      onPickExample={(id) => {
        const ex = EXAMPLES.find((e) => e.id === id);
        if (ex) setValue(ex.value);
      }}
    />
  );
}
