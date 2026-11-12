import type { ComponentType } from "react";
import { Link } from "react-router";
import { ExternalLink, Footprints, Headset, MessageCircle, UserPlus, Users } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";
import { communityUrl } from "@/lib/communityLink";
import { contactHref } from "@/lib/contactHref";
import { TAB_ROUTES } from "@/lib/routes";
import { BlockCard } from "./BlockCard";
import type { BlockOf, BlockProps } from "./types";

type StepId = BlockOf<"proximosPassos">["steps"][number]["id"];

interface StepCopy {
  title: string;
  hint: string;
  action: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
}

const COPY: Record<StepId, StepCopy> = {
  conectar_whatsapp: {
    title: "Conectar o WhatsApp",
    hint: "É por onde os seus clientes falam com você.",
    action: "Conectar número",
    icon: MessageCircle,
  },
  convidar_equipe: {
    title: "Convidar a equipe",
    hint: "Quem atende junto com o atendente entra aqui.",
    action: "Convidar pessoas",
    icon: UserPlus,
  },
  comunidade: {
    title: "Entrar na comunidade",
    hint: "Tire dúvidas e veja como outros negócios usam.",
    action: "Abrir a comunidade",
    icon: Users,
  },
  consultoria: {
    title: "Pedir uma consultoria",
    hint: "Se preferir ajuda para montar tudo com a gente.",
    action: "Falar com a gente",
    icon: Headset,
  },
};

export interface ProximosPassosViewProps {
  steps: readonly { id: StepId }[];
  note?: string;
  compact?: boolean;
  /** Link da comunidade (`VITE_COMMUNITY_URL`); sem ele o passo não aparece. */
  communityHref: string | null;
  consultoriaHref: string;
}

/** `proximosPassos`: conectar WhatsApp, convidar equipe, comunidade (se configurada) e consultoria. */
export function ProximosPassosView({ steps, note, compact, communityHref, consultoriaHref }: ProximosPassosViewProps) {
  const known = steps.filter((s) => Object.prototype.hasOwnProperty.call(COPY, s.id) && (s.id !== "comunidade" || communityHref));
  return (
    <BlockCard title="Próximos passos" icon={Footprints} note={compact ? undefined : note}>
      <ul className="space-y-2" aria-label="Próximos passos">
        {known.map((s) => {
          const c = COPY[s.id];
          const Icon = c.icon;
          const cls = buttonClassName("secondary", "sm", "shrink-0");
          return (
            <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-field border border-border-subtle bg-surface-sunken p-2">
              <Icon className="size-4 shrink-0 text-brand-600" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-text-primary">{c.title}</p>
                {!compact && <p className="text-caption text-text-secondary">{c.hint}</p>}
              </div>
              {s.id === "conectar_whatsapp" && (
                <Link to={`${TAB_ROUTES.settings}?secao=channels`} className={cls}>
                  {c.action}
                </Link>
              )}
              {s.id === "convidar_equipe" && (
                <Link to={TAB_ROUTES.team} className={cls}>
                  {c.action}
                </Link>
              )}
              {s.id === "comunidade" && communityHref && (
                <a href={communityHref} target="_blank" rel="noopener noreferrer" className={cls}>
                  {c.action}
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              )}
              {s.id === "consultoria" && (
                <a href={consultoriaHref} className={cls}>
                  {c.action}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </BlockCard>
  );
}

export function ProximosPassosBlock({ block, ctx }: BlockProps<"proximosPassos">) {
  const steps = Array.isArray(block.steps) ? block.steps : [];
  return (
    <ProximosPassosView
      steps={steps}
      note={block.note}
      compact={ctx.compact}
      communityHref={communityUrl()}
      consultoriaHref={contactHref("implantacao")}
    />
  );
}
