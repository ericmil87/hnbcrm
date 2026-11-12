import { useState } from "react";
import { Info } from "lucide-react";
import { Tabs, TabPanel } from "@/components/ui/Tabs";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";
import { Reveal } from "./S3Parts";
import { PROFILE_TABS } from "./S4Data";

const ID_PREFIX = "perfis";

/** S4: abas por perfil; cada aba traz três pares "Hoje" / "Com o HNBCRM" com uma cena curta (exemplo ilustrativo). */
export function S4Profiles() {
  const [active, setActive] = useState<string>(PROFILE_TABS[0].id);
  const tab = PROFILE_TABS.find((t) => t.id === active) ?? PROFILE_TABS[0];

  return (
    <LandingSection
      id={LANDING_ANCHORS.profiles}
      eyebrow="Por perfil"
      title="O que muda no seu dia"
      subtitle="Escolha o seu perfil. Três dores, três cenas."
      tone="raised"
    >
      <Tabs
        value={active}
        onValueChange={setActive}
        items={PROFILE_TABS.map((t) => ({ id: t.id, label: t.label }))}
        ariaLabel="Perfis"
        idPrefix={ID_PREFIX}
      />
      <Reveal className="mt-6">
        {/* `key` remonta o painel: as cenas da aba escolhida entram de novo. */}
        <TabPanel key={tab.id} id={tab.id} idPrefix={ID_PREFIX}>
          <ul className="grid gap-4 md:grid-cols-3">
            {tab.pains.map((pain) => (
              <li
                key={pain.today}
                className="flex min-w-0 flex-col rounded-card border border-border bg-surface-base p-4 shadow-card"
              >
                <p className="text-caption font-semibold uppercase tracking-wide text-text-muted">Hoje</p>
                <p className="mt-1 text-base font-medium text-text-primary">{pain.today}</p>
                <div className="mt-4 flex flex-1 flex-col justify-end">
                  <p className="mb-1.5 text-caption text-text-muted">Exemplo ilustrativo</p>
                  <div role="group" aria-label={pain.sceneLabel}>
                    {pain.scene}
                  </div>
                </div>
                <p className="mt-4 text-caption font-semibold uppercase tracking-wide text-brand-600">Com o HNBCRM</p>
                <p className="mt-1 text-base text-text-secondary">{pain.with}</p>
              </li>
            ))}
          </ul>
          {tab.note && (
            <p role="note" className="mt-4 flex items-start gap-2 rounded-card bg-surface-sunken p-3 text-sm text-text-secondary">
              <Info className="mt-0.5 size-4 shrink-0 text-semantic-info" aria-hidden="true" />
              {tab.note}
            </p>
          )}
        </TabPanel>
      </Reveal>
    </LandingSection>
  );
}
