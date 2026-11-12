import { SEO } from "@/components/SEO";
import { OrganizationStructuredData } from "@/components/StructuredData";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { S1Hero } from "@/components/landing/sections/S1Hero";
import { S2Machine } from "@/components/landing/sections/S2Machine";
import { S3Team } from "@/components/landing/sections/S3Team";
import { SFeatures } from "@/components/landing/sections/SFeatures";
import { S4Profiles } from "@/components/landing/sections/S4Profiles";
import { S5HowItStarts } from "@/components/landing/sections/S5HowItStarts";
import { S6PriceSummary } from "@/components/landing/sections/S6PriceSummary";
import { S7Services } from "@/components/landing/sections/S7Services";
import { S7bSocialProof } from "@/components/landing/sections/S7bSocialProof";
import { SAuthor } from "@/components/landing/sections/SAuthor";
import { S8Community } from "@/components/landing/sections/S8Community";
import { S9Faq } from "@/components/landing/sections/S9Faq";
import { FinalCta } from "@/components/landing/sections/FinalCta";
import { LandingFooter } from "@/components/landing/sections/Footer";
import { TRIAL } from "../../convex/lib/plans";

/**
 * Landing (`/`): só compõe o cabeçalho e as seções. Cada seção vive no seu
 * arquivo em `components/landing/sections/` (âncoras em `landingCopy.ts`) e as
 * cenas usam o kit de `components/landing/kit/`. A tabela de preços completa
 * fica só em `/precos`.
 */
export function LandingPage() {
  return (
    <>
      <SEO
        ogImage="/og-image.png"
        preloadDisplayFont
        title="HNBCRM — CRM com atendimento IA no WhatsApp"
        description={`CRM para vender pelo WhatsApp: funil, conversas e tarefas num lugar só, com atendente de IA que sugere respostas e chama a equipe na hora certa. Usuários ilimitados. Teste ${TRIAL.days} dias, sem cartão.`}
      />
      <OrganizationStructuredData />
      <div className="min-h-screen bg-surface-base text-text-primary">
        <LandingHeader />
        <main>
          <S1Hero />
          <S2Machine />
          <S3Team />
          <SFeatures />
          <S4Profiles />
          <S5HowItStarts />
          <S6PriceSummary />
          <S7Services />
          <S7bSocialProof />
          <SAuthor />
          <S8Community />
          <S9Faq />
          <FinalCta />
        </main>
        <LandingFooter />
      </div>
    </>
  );
}
