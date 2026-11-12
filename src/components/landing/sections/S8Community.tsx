import { lazy, Suspense } from "react";
import { Check, ExternalLink, Github, History } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { communityUrl } from "@/lib/communityLink";
import { cn } from "@/lib/utils";
import { NewsletterForm } from "../NewsletterForm";
import { COMMUNITY_COPY } from "../manifestoCopy";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

const CommunityQr = lazy(() => import("./CommunityQr"));

function CommunityCard({ title, tagline, children, className }: { title: string; tagline: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col rounded-card border border-border bg-surface-raised p-5 md:p-6", className)}>
      <p className="text-caption font-semibold uppercase tracking-wide text-brand-600">{tagline}</p>
      <h3 className="mt-1 font-display text-lg font-bold text-text-primary md:text-xl">{title}</h3>
      {children}
    </div>
  );
}

const linkClass =
  "inline-flex min-h-11 items-center gap-2 text-sm font-medium text-brand-400 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500";

/**
 * S8: comunidade. Sempre aparece: grupo do WhatsApp (só com `VITE_COMMUNITY_URL` https
 * válida, e com QR code no computador), novidades por e-mail e código aberto.
 */
export function S8Community() {
  const url = communityUrl();
  const desktop = useMediaQuery("(min-width: 768px) and (pointer: fine)");
  const { group, newsletter, openSource } = COMMUNITY_COPY;
  return (
    <LandingSection
      id={LANDING_ANCHORS.community}
      eyebrow={COMMUNITY_COPY.eyebrow}
      title={COMMUNITY_COPY.title}
      subtitle={COMMUNITY_COPY.subtitle}
    >
      <div className={cn("grid grid-cols-1 gap-4 md:gap-6", url ? "lg:grid-cols-3" : "md:grid-cols-2")}>
        {url && (
          <CommunityCard title={group.title} tagline={group.tagline}>
            <ul className="mt-4 space-y-2">
              {group.lines.map((line) => (
                <li key={line} className="flex items-start gap-2 text-text-primary">
                  <Check className="mt-1 size-4 shrink-0 text-semantic-success" aria-hidden="true" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClassName("primary", "lg", "mt-6 w-full")}
            >
              {group.cta}
            </a>
            {desktop && (
              <figure className="mt-6 flex flex-col items-center gap-2">
                <Suspense fallback={<div className="size-36" aria-hidden="true" />}>
                  <CommunityQr url={url} />
                </Suspense>
                <figcaption className="text-sm text-text-secondary">{group.qrCaption}</figcaption>
              </figure>
            )}
          </CommunityCard>
        )}
        <CommunityCard title={newsletter.title} tagline={newsletter.tagline}>
          <p className="mb-4 mt-3 text-text-secondary">{newsletter.text}</p>
          <NewsletterForm source="landing" />
        </CommunityCard>
        <CommunityCard title={openSource.title} tagline={openSource.tagline}>
          <p className="mt-3 text-text-secondary">{openSource.text}</p>
          <div className="mt-4 flex flex-col items-start">
            <a href={openSource.repoHref} target="_blank" rel="noopener noreferrer" className={linkClass}>
              <Github className="size-4" aria-hidden="true" />
              {openSource.repoLabel}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
            <a href={openSource.changelogHref} target="_blank" rel="noopener noreferrer" className={linkClass}>
              <History className="size-4" aria-hidden="true" />
              {openSource.changelogLabel}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </div>
        </CommunityCard>
      </div>
    </LandingSection>
  );
}
