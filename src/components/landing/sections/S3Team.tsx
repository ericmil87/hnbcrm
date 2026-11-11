import { Bot, Camera, MessageCircle, MessageSquare, Send, Sparkles, Users, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Bubble } from "../kit";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";
import { HelpRequest, Reveal, SceneBox } from "./S3Parts";

/** Cartões e canais da seção "Três no mesmo time" (copy aprovada em 11/11/2026). */
const CARDS: readonly { id: "atendente" | "copiloto" | "equipe"; title: string; icon: LucideIcon; benefit: string; extra?: string }[] = [
  {
    id: "atendente",
    title: "Atendente",
    icon: Bot,
    benefit:
      "Fala com o seu cliente no WhatsApp, do seu jeito. Começa em modo sugestão: ele escreve, você aprova com um toque. Quando confiar, você libera o automático.",
    extra: "Quando o cliente manda áudio, a IA pode responder em áudio (só na conexão por QR code).",
  },
  {
    id: "copiloto",
    title: "Copiloto",
    icon: Sparkles,
    benefit:
      "Fala com você. Responde sobre o seu CRM, resume o dia e ajuda a configurar. Pede confirmação antes de mudar algo. Também no Telegram.",
  },
  {
    id: "equipe",
    title: "Sua equipe",
    icon: Users,
    benefit:
      "Entra quando precisa de gente. A IA passa para a sua equipe com o resumo pronto, e você devolve a conversa com uma instrução.",
  },
];

export const TEAM_CHANNELS: readonly { id: string; name: string; line: string; icon: LucideIcon; ready: boolean }[] = [
  { id: "whatsapp", name: "WhatsApp", line: "Atendente e equipe", icon: MessageCircle, ready: true },
  { id: "telegram", name: "Telegram", line: "Para o Copiloto e a equipe", icon: Send, ready: true },
  { id: "instagram", name: "Instagram", line: "Mesma caixa de entrada", icon: Camera, ready: false },
  { id: "messenger", name: "Messenger", line: "Mesma caixa de entrada", icon: MessageSquare, ready: false },
];

function AtendenteScene() {
  return (
    <SceneBox label="Exemplo: o Atendente sugere e você aprova">
      <Bubble variant="in" time="10:12" enter>
        Vocês abrem sábado?
      </Bubble>
      <Bubble variant="ai" label="Sugestão da IA" time="10:12" enter enterDelayMs={400}>
        Abrimos das 9h às 13h. Quer que eu veja um horário para você?
      </Bubble>
      <Bubble variant="system" enter enterDelayMs={800}>
        Você aprovou · enviada
      </Bubble>
    </SceneBox>
  );
}

function CopilotoScene() {
  return (
    <SceneBox label="Exemplo: o Copiloto responde sobre o seu CRM">
      <Bubble variant="out" label="Você" time="08:02" enter>
        Quem pediu preço hoje?
      </Bubble>
      <Bubble variant="ai" side="start" label="Copiloto" time="08:02" enter enterDelayMs={400}>
        Três pessoas. A Marina quer fechar. O Paulo e a Ingrid pediram valor.
      </Bubble>
      <Bubble variant="ai" side="start" label="Copiloto" time="08:02" tail={false} enter enterDelayMs={800}>
        Quer que eu crie uma tarefa para você ligar para o Paulo?
      </Bubble>
    </SceneBox>
  );
}

function EquipeScene() {
  return (
    <SceneBox label="Exemplo: a IA pede ajuda e a equipe assume">
      <HelpRequest title="Marina quer fechar" body="Quer o pacote de 3 sessões e prefere sábado." enter />
      <Bubble variant="out" label="Ana" time="23:16" enter enterDelayMs={400}>
        Assumi. Vou mandar o Pix.
      </Bubble>
      <Bubble variant="system" enter enterDelayMs={800}>
        Devolvida à IA com a instrução "Confirme sábado às 10h30."
      </Bubble>
    </SceneBox>
  );
}

const SCENES = { atendente: AtendenteScene, copiloto: CopilotoScene, equipe: EquipeScene } as const;

/** S3: três cartões (Atendente, Copiloto, Sua equipe), cada um com microcena, e a faixa de canais. */
export function S3Team() {
  return (
    <LandingSection
      id={LANDING_ANCHORS.team}
      eyebrow="Humanos e IAs no mesmo time"
      title="Três no mesmo time"
      subtitle="Cada um tem o seu papel. Ninguém atropela ninguém."
    >
      <ul className="grid gap-4 md:grid-cols-3">
        {CARDS.map((card) => {
          const Scene = SCENES[card.id];
          const Icon = card.icon;
          return (
            <li key={card.id} className="flex min-w-0 flex-col rounded-card border border-border bg-surface-raised p-4 shadow-card md:p-5">
              <div className="flex items-center gap-3">
                <span aria-hidden="true" className="inline-flex size-10 items-center justify-center rounded-full bg-brand-600 text-white">
                  <Icon className="size-5" />
                </span>
                <h3 className="font-display text-xl font-bold text-text-primary">{card.title}</h3>
              </div>
              <p className="mt-3 text-base text-text-secondary">{card.benefit}</p>
              {card.extra && <p className="mt-2 text-sm text-text-muted">{card.extra}</p>}
              <Reveal className="mt-4 flex flex-1 flex-col justify-end">
                <Scene />
              </Reveal>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-sm text-text-muted">Sem cobrar por pessoa: a equipe inteira entra em qualquer plano.</p>

      <div className="mt-8">
        <h3 className="sr-only">Canais</h3>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TEAM_CHANNELS.map((channel) => {
            const Icon = channel.icon;
            return (
              <li key={channel.id} className="flex min-h-14 items-center gap-3 rounded-card border border-border-subtle bg-surface-raised px-3 py-2">
                <Icon className="size-5 shrink-0 text-text-secondary" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-text-primary">{channel.name}</span>
                  <span className="block text-caption text-text-muted">{channel.line}</span>
                </span>
                <Badge variant={channel.ready ? "success" : "warning"}>{channel.ready ? "Pronto" : "Em liberação"}</Badge>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-sm text-text-muted">
          Instagram e Messenger estão sendo liberados aos poucos, conforme a aprovação da Meta.
        </p>
      </div>
    </LandingSection>
  );
}
