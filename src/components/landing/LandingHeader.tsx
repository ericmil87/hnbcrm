import { Link } from "react-router";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { buttonClassName } from "@/components/ui/Button";
import { PublicThemeButton } from "@/components/landing/PublicThemeButton";
import { startHref } from "@/lib/onboardingEntry";
import { cn } from "@/lib/utils";
import { LANDING_ANCHORS, PRIMARY_CTA_LABEL } from "./sections/landingCopy";
import { HomeLogoLink } from "@/components/landing/HomeLogoLink";

interface NavLink {
  href: string;
  label: string;
}

/** Links da navegação (copy aprovada). */
export function landingNavLinks(): NavLink[] {
  return [
    { href: `#${LANDING_ANCHORS.machine}`, label: "Como funciona" },
    { href: `#${LANDING_ANCHORS.features}`, label: "Funcionalidades" },
    { href: `#${LANDING_ANCHORS.price}`, label: "Preços" },
    { href: `#${LANDING_ANCHORS.services}`, label: "Feito com você" },
    { href: `#${LANDING_ANCHORS.community}`, label: "Comunidade" },
  ];
}

const linkClass = cn(
  "inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
);

/**
 * Cabeçalho fixo da landing: logo, navegação por âncoras (segunda linha com
 * rolagem horizontal no celular), botão de tema, Entrar e Testar grátis.
 * "Testar grátis" vai para `/comecar` (`startHref`).
 */
export function LandingHeader() {
  const links = landingNavLinks();
  return (
    <header className="sticky top-0 z-40 border-b border-border-subtle bg-surface-base/95 backdrop-blur supports-[backdrop-filter]:bg-surface-base/80">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-2 px-4 pt-2 md:flex-nowrap md:py-2">
        <HomeLogoLink>
          <BrandLogo variant="responsive" size="md" decorative />
        </HomeLogoLink>
        <nav
          aria-label="Seções da página"
          className="order-last -mx-4 flex w-[calc(100%+2rem)] gap-1 overflow-x-auto px-3 pb-1 [scrollbar-width:none] md:order-none md:mx-0 md:w-auto md:flex-1 md:justify-center md:overflow-visible md:px-0 md:pb-0 [&::-webkit-scrollbar]:hidden"
        >
          {links.map((link) => (
            <a key={link.href} href={link.href} className={linkClass}>
              {link.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <PublicThemeButton />
          <Link to="/entrar" className={buttonClassName("ghost", "sm")}>
            Entrar
          </Link>
          <Link to={startHref()} className={buttonClassName("primary", "sm")}>
            {PRIMARY_CTA_LABEL}
          </Link>
        </div>
      </div>
    </header>
  );
}
