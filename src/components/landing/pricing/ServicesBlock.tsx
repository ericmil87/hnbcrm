import { Check } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { formatMoney } from "@/lib/format";
import { serviceDisplays } from "@/lib/pricingCatalog";
import { contactHref } from "@/lib/contactHref";
import { SERVICES } from "../../../../convex/lib/plans";
import { CUSTOM_SERVICE_COPY, SERVICES_FOOTER, SERVICE_COPY, followUpText, servicesSubtitle } from "./pricingCopy";

const brl0 = (v: number) => formatMoney(v, "BRL", { fractionDigits: 0 });

function IncludesList({ items }: { items: readonly string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((t) => (
        <li key={t} className="flex items-start gap-2 text-sm text-text-primary">
          <Check size={16} className="mt-0.5 shrink-0 text-semantic-success" aria-hidden="true" />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Implantação e consultoria": pacotes e acompanhamento vêm de `SERVICES` (catálogo).
 * Os botões abrem um e-mail (`contactHref`); o formulário que cria lead vem na Onda 5.
 */
export function ServicesBlock() {
  const packages = serviceDisplays();
  const href = contactHref("implantacao");

  return (
    <section id="implantacao" aria-labelledby="services-heading" className="space-y-6">
      <div className="max-w-3xl">
        <Badge variant="brand">Opcional</Badge>
        <h2 id="services-heading" className="mt-2 text-2xl font-bold text-text-primary">
          Quer que a gente monte junto?
        </h2>
        <p className="mt-2 text-text-secondary">{servicesSubtitle()}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {packages.map((s) => (
          <Card key={s.key} className="flex flex-col gap-3">
            <h3 className="text-lg font-bold text-text-primary">{s.label}</h3>
            <p className="tabular-nums text-text-primary">
              <span className="text-3xl font-bold">{brl0(s.brl)}</span>
              {s.perUnitBrl !== null && (
                <span className="mt-1 block text-sm text-text-secondary">
                  + {brl0(s.perUnitBrl)} por unidade adicional
                </span>
              )}
            </p>
            <p className="text-sm text-text-secondary">{SERVICE_COPY[s.key].audience}</p>
            <div className="flex-1">
              <IncludesList items={SERVICE_COPY[s.key].includes} />
            </div>
          </Card>
        ))}
        <Card variant="sunken" className="flex flex-col gap-3">
          <h3 className="text-lg font-bold text-text-primary">{SERVICES.consultoria.label}</h3>
          <p className="text-3xl font-bold text-text-primary">Sob orçamento</p>
          <p className="text-sm text-text-secondary">{CUSTOM_SERVICE_COPY.audience}</p>
          <div className="flex-1">
            <IncludesList items={CUSTOM_SERVICE_COPY.includes} />
          </div>
        </Card>
      </div>

      <p className="text-text-primary">
        <strong>Acompanhamento mensal (opcional):</strong> <span className="tabular-nums">{followUpText()}</span>
      </p>

      <div className="flex flex-col gap-3 sm:flex-row">
        <a href={href} className="inline-block">
          <Button variant="primary" size="lg" className="w-full sm:w-auto">
            Falar com a gente
          </Button>
        </a>
        <a href={href} className="inline-block">
          <Button variant="secondary" size="lg" className="w-full sm:w-auto">
            Pedir orçamento
          </Button>
        </a>
      </div>

      <p className="text-sm text-text-muted">{SERVICES_FOOTER}</p>
    </section>
  );
}
