import { useRef, useState, type ReactNode } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  AiAvatar,
  AudioBubble,
  Bubble,
  ChatWindow,
  MiniFunnel,
  PhoneNotification,
  SceneLoop,
  TypingDots,
  type SceneLoopState,
} from "../kit";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";
import {
  MACHINE_CAPTION,
  MACHINE_DESCRIPTION,
  MACHINE_EYEBROW,
  MACHINE_FUNNEL_COLUMNS,
  MACHINE_LABEL,
  MACHINE_PANELS,
  MACHINE_STEPS,
  MACHINE_SUBTITLE,
  MACHINE_SWIPE_HINT,
  MACHINE_TITLE,
  MACHINE_TRANSCRIPT,
} from "./S2MachineCopy";

type PanelId = (typeof MACHINE_PANELS)[number]["id"];

function Panel({ id, children }: { id: PanelId; children: ReactNode }) {
  const meta = MACHINE_PANELS.find((p) => p.id === id)!;
  return (
    <div
      data-panel={id}
      className="w-[86%] shrink-0 snap-center space-y-2 md:w-auto md:min-w-0 md:shrink"
    >
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="font-display text-lg font-semibold text-text-primary">{meta.title}</p>
        <Badge variant="default">{meta.badge}</Badge>
      </div>
      {children}
    </div>
  );
}

function ConversationPanel({ scene }: { scene: SceneLoopState }) {
  const typing = scene.step?.id === "digitando";
  return (
    <ChatWindow
      title="Marina"
      subtitle="online"
      typing={typing}
      avatar={<Avatar name="Marina" size="md" />}
      bodyClassName="h-[26rem] justify-end overflow-hidden"
    >
      <Bubble variant="system">Hoje</Bubble>
      {scene.reached("audio") && (
        <AudioBubble
          variant="in"
          duration="0:14"
          time="23:14"
          transcript={scene.reached("transcricao") ? MACHINE_TRANSCRIPT : undefined}
          enter
        />
      )}
      {typing && <TypingDots />}
      {scene.reached("resposta") && (
        <Bubble variant="ai" label="Atendente IA" time="23:14" ticks="read" enter>
          Oi, Marina! Sábado temos às 9h e às 10h30. A limpeza de pele sai por R$ 180. Qual horário você prefere?
        </Bubble>
      )}
      {scene.reached("cliente-ok") && (
        <Bubble variant="in" time="23:15" enter>
          Fechado, 10h30!
        </Bubble>
      )}
      {scene.reached("ia-ok") && (
        <Bubble variant="ai" label="Atendente IA" time="23:15" ticks="delivered" enter>
          Anotei 10h30. A equipe confirma com você amanhã cedo.
        </Bubble>
      )}
    </ChatWindow>
  );
}

function FunnelPanel({ scene }: { scene: SceneLoopState }) {
  const columnId = scene.reached("ia-ok") ? "agendado" : scene.reached("resposta") ? "interessado" : "novo";
  return (
    <div className="rounded-card border border-border bg-surface-raised p-3 shadow-card">
      <MiniFunnel
        columns={MACHINE_FUNNEL_COLUMNS}
        moving={scene.reached("audio") ? { title: "Marina", subtitle: "limpeza de pele", columnId } : null}
        enter
        className="min-h-[24rem]"
      />
    </div>
  );
}

function YouPanel({ scene }: { scene: SceneLoopState }) {
  return (
    <div className="min-h-[26rem] space-y-3">
      {scene.reached("aviso") && (
        <PhoneNotification
          title="Marina quer fechar. Assumir?"
          actions={[{ label: "Depois" }, { label: "Assumir", primary: true }]}
          enter
        />
      )}
      {scene.reached("equipe") && (
        <ChatWindow title="Marina" subtitle="online" avatar={<Avatar name="Marina" size="md" />} bodyClassName="gap-1.5">
          <Bubble variant="system" enter>
            Você assumiu a conversa. A IA pausou.
          </Bubble>
          <Bubble variant="out" label="Ana" time="23:16" ticks="sent" enter>
            Oi, Marina! Aqui é a Ana. Vou te passar o Pix do sinal.
          </Bubble>
        </ChatWindow>
      )}
      {scene.reached("resumo") && (
        <ChatWindow title="Copiloto" subtitle="resumo de hoje" avatar={<AiAvatar />}>
          <Bubble variant="ai" side="start" label="Copiloto · resumo de hoje" enter>
            <strong>3 leads quentes hoje</strong>
            <br />
            Marina · pronta para fechar
            <br />
            Paulo · pediu valor do pacote
            <br />
            Ingrid · voltou a falar hoje
          </Bubble>
        </ChatWindow>
      )}
    </div>
  );
}

/**
 * Cena única em loop (~20 s) com três painéis: Conversa, Funil e Você. Lado a
 * lado a partir de `md`; no celular os painéis rolam na horizontal com snap e
 * os pontos de navegação levam a cada um. `SceneLoop` cuida da pausa (botão e
 * fora da tela), do estado final com movimento reduzido e da descrição para
 * leitor de tela (a cena animada fica `aria-hidden`).
 */
export function S2Machine() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const reduced = usePrefersReducedMotion();

  function onScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    const index = Math.round((el.scrollLeft / Math.max(1, el.scrollWidth - el.clientWidth)) * (MACHINE_PANELS.length - 1));
    setActive(Math.min(MACHINE_PANELS.length - 1, Math.max(0, index)));
  }

  function goTo(id: PanelId) {
    const panel = scrollerRef.current?.querySelector<HTMLElement>(`[data-panel="${id}"]`);
    panel?.scrollIntoView?.({ behavior: reduced ? "auto" : "smooth", inline: "center", block: "nearest" });
  }

  return (
    <LandingSection
      id={LANDING_ANCHORS.machine}
      eyebrow={MACHINE_EYEBROW}
      title={MACHINE_TITLE}
      subtitle={MACHINE_SUBTITLE}
      tone="raised"
    >
      <p className="mb-3 text-caption text-text-muted md:hidden">{MACHINE_SWIPE_HINT}</p>
      <SceneLoop steps={MACHINE_STEPS} label={MACHINE_LABEL} description={MACHINE_DESCRIPTION}>
        {(scene) => (
          <div
            ref={scrollerRef}
            onScroll={onScroll}
            className={cn(
              "-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              "md:mx-0 md:grid md:grid-cols-3 md:gap-4 md:overflow-visible md:px-0 md:pb-0"
            )}
          >
            <Panel id="conversa">
              <ConversationPanel scene={scene} />
            </Panel>
            <Panel id="funil">
              <FunnelPanel scene={scene} />
            </Panel>
            <Panel id="voce">
              <YouPanel scene={scene} />
            </Panel>
          </div>
        )}
      </SceneLoop>
      <div role="group" aria-label="Painéis da cena" className="mt-1 flex justify-center gap-1 md:hidden">
        {MACHINE_PANELS.map((panel, i) => (
          <button
            key={panel.id}
            type="button"
            onClick={() => goTo(panel.id)}
            aria-label={panel.title}
            aria-current={i === active ? "true" : undefined}
            className="inline-flex size-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <span
              aria-hidden="true"
              className={cn("block h-2 rounded-full transition-all", i === active ? "w-6 bg-brand-600" : "w-2 bg-border-strong")}
            />
          </button>
        ))}
      </div>
      <p className="mt-3 max-w-2xl text-caption text-text-muted">{MACHINE_CAPTION}</p>
    </LandingSection>
  );
}
