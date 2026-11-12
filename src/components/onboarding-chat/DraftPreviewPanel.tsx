import { Bot, BookOpen, Building2, Columns3, MessageSquareText } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import type { OnboardingDraft } from "../../../convex/lib/onboardingDraft";
import { formatCount } from "@/lib/format";
import { plainModelText } from "@/lib/onboardingChat";

export interface DraftPreviewPanelProps {
  /** Rascunho gravado (`onboardingSessions.getSession().draft`); null = ainda sem rascunho. */
  draft: OnboardingDraft | null;
}

const TONE_LABEL: Record<OnboardingDraft["persona"]["tone"], string> = {
  formal: "formal",
  amigavel: "amigável",
  descontraido: "descontraído",
};

function Section({ title, icon: Icon, children }: { title: string; icon: ComponentType<{ className?: string }>; children: ReactNode }) {
  return (
    <section className="rounded-card border border-border-subtle bg-surface-raised p-3 shadow-card">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Icon className="size-4 text-brand-600" aria-hidden="true" />
        {title}
      </h3>
      <div className="mt-2 text-sm text-text-secondary">{children}</div>
    </section>
  );
}

/**
 * Prévia viva da operação (desktop, à direita da conversa): um painel simples
 * do rascunho atual. Os cartões ricos com "Ajustar" são do P3.3. Todo texto do
 * rascunho é renderizado como texto puro.
 */
export function DraftPreviewPanel({ draft }: DraftPreviewPanelProps) {
  return (
    <aside aria-labelledby="previa-operacao-titulo" className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div>
        <h2 id="previa-operacao-titulo" className="text-base font-semibold text-text-primary">
          Sua operação
        </h2>
        <p className="text-caption text-text-muted">Atualiza enquanto você conversa. Nada é criado antes do seu clique.</p>
      </div>
      {!draft ? (
        <p className="rounded-card border border-dashed border-border p-4 text-sm text-text-muted">
          Conte sobre o seu negócio e a prévia aparece aqui: funil, atendente e o que ele sabe.
        </p>
      ) : (
        <>
          <Section title="Negócio" icon={Building2}>
            <p className="font-medium text-text-primary">{plainModelText(draft.business.name) || "Sem nome ainda"}</p>
            {draft.business.description && (
              <p className="mt-1 line-clamp-4 whitespace-pre-wrap">{plainModelText(draft.business.description)}</p>
            )}
          </Section>
          <Section title={plainModelText(draft.funnel.name) || "Funil"} icon={Columns3}>
            <ol className="flex flex-wrap gap-1.5" aria-label="Etapas do funil">
              {[...draft.funnel.stages]
                .sort((a, b) => a.order - b.order)
                .map((s, i) => (
                  <li key={`${i}:${s.name}`} className="rounded-field bg-surface-sunken px-2 py-1 text-caption text-text-primary">
                    {plainModelText(s.name)}
                  </li>
                ))}
            </ol>
          </Section>
          <Section title="Atendente IA" icon={Bot}>
            <p>
              <span className="font-medium text-text-primary">{plainModelText(draft.persona.attendantName)}</span>, tom{" "}
              {TONE_LABEL[draft.persona.tone]}
            </p>
          </Section>
          <div className="grid grid-cols-2 gap-3">
            <Section title="Conhecimento" icon={BookOpen}>
              <p className="tabular-nums">{formatCount(draft.knowledge.length)} itens</p>
            </Section>
            <Section title="Respostas" icon={MessageSquareText}>
              <p className="tabular-nums">{formatCount(draft.quickReplies.length)} atalhos</p>
            </Section>
          </div>
        </>
      )}
    </aside>
  );
}
