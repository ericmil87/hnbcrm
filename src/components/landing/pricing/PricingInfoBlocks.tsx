import { Check } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import {
  DEFINITIONS,
  NOT_CHARGED,
  QUOTA_END_TEXT,
  THIRD_PARTY_POINTS,
  WHAT_IS_ATTENDED,
  WHAT_IS_ATTENDED_INTRO,
  addonLines,
  faqItems,
} from "./pricingCopy";

/** Texto com trechos `**negrito**`. */
function Rich({ text }: { text: string }) {
  const parts = text.split("**");
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <strong key={`b:${i}`} className="font-semibold text-text-primary">
            {p}
          </strong>
        ) : (
          <span key={`t:${i}`}>{p}</span>
        ),
      )}
    </>
  );
}

function CheckList({ items }: { items: readonly string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((t) => (
        <li key={t} className="flex items-start gap-2 text-sm text-text-secondary">
          <Check size={16} className="mt-0.5 shrink-0 text-semantic-success" aria-hidden="true" />
          <span>
            <Rich text={t} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function AddonsBlock() {
  return (
    <section aria-labelledby="addons-heading">
      <h2 id="addons-heading" className="mb-4 text-2xl font-bold text-text-primary">
        Avulsos
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {addonLines().map((a) => (
          <Card key={a.title} variant="sunken" className="flex flex-col">
            <h3 className="text-sm font-semibold text-text-primary">{a.title}</h3>
            <p className="mt-1 text-lg font-bold tabular-nums text-text-primary">{a.price}</p>
            <p className="mt-1 text-sm text-text-secondary">{a.detail}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}

export function DefinitionsBlock() {
  return (
    <section id="definicoes" aria-labelledby="definitions-heading" className="scroll-mt-20 space-y-4">
      <h2 id="definitions-heading" className="text-2xl font-bold text-text-primary">
        O que conta e o que não conta
      </h2>

      <Card className="border-brand-500 bg-brand-500/10">
        <h3 className="mb-1 text-lg font-semibold text-text-primary">O que é uma pessoa atendida pela IA</h3>
        <p className="mb-3 text-sm text-text-secondary">{WHAT_IS_ATTENDED_INTRO}</p>
        <CheckList items={WHAT_IS_ATTENDED} />
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <h3 className="mb-3 text-lg font-semibold text-text-primary">O que não cobramos</h3>
          <CheckList items={NOT_CHARGED} />
        </Card>
        <div className="grid gap-4">
          <Card>
            <h3 className="mb-2 text-lg font-semibold text-text-primary">Quando a franquia acaba</h3>
            <p className="text-sm text-text-secondary">{QUOTA_END_TEXT}</p>
          </Card>
          <Card>
            <h3 className="mb-3 text-lg font-semibold text-text-primary">Terceiros, sem margem nossa</h3>
            <CheckList items={THIRD_PARTY_POINTS} />
          </Card>
        </div>
      </div>

      <Card variant="sunken">
        <h3 className="mb-3 text-lg font-semibold text-text-primary">Outros termos</h3>
        <dl className="grid gap-4 sm:grid-cols-3">
          {DEFINITIONS.map((d) => (
            <div key={d.term}>
              <dt className="text-sm font-semibold text-text-primary">{d.term}</dt>
              <dd className="text-sm text-text-secondary">{d.text}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </section>
  );
}

export function PricingFaq({ firstOpen }: { firstOpen: boolean }) {
  const faq = faqItems();
  return (
    <section id="perguntas" aria-labelledby="faq-heading" className="scroll-mt-20">
      <h2 id="faq-heading" className="mb-3 text-2xl font-bold text-text-primary">
        Perguntas sobre preço
      </h2>
      <Card className="py-2 md:py-3">
        {faq.map((f, i) => (
          <CollapsibleSection key={f.question} title={f.question} defaultOpen={firstOpen && i === 0}>
            <p className="pb-3 text-sm text-text-secondary">{f.answer}</p>
          </CollapsibleSection>
        ))}
      </Card>
    </section>
  );
}
