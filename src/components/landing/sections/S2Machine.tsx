import type { ReactNode } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import {
  AiAvatar,
  AudioBubble,
  Bubble,
  ChatFeed,
  ChatWindow,
  FunnelRail,
  PhoneFrame,
  PhoneNotification,
  SceneLoop,
  SceneSteps,
  TypingDots,
  type SceneLoopState,
} from "../kit";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";
import {
  MACHINE_BADGE,
  MACHINE_CAPTION,
  MACHINE_CHAPTERS,
  MACHINE_DESCRIPTION,
  MACHINE_EYEBROW,
  MACHINE_FUNNEL_CARDS,
  MACHINE_FUNNEL_COLUMNS,
  MACHINE_LABEL,
  MACHINE_PANELS,
  MACHINE_STEPS,
  MACHINE_SUBTITLE,
  MACHINE_TEXT,
  MACHINE_TITLE,
  MACHINE_TRANSCRIPT,
} from "./S2MachineCopy";

const T = MACHINE_TEXT;

type PanelId = (typeof MACHINE_PANELS)[number]["id"];

/**
 * Altura reservada dos painéis, igual do primeiro ao último quadro: nada na
 * cena muda de tamanho, tudo entra e sai dentro destas caixas.
 */
const STAGE_HEIGHT = "h-[23rem] md:h-[28rem]";

/** Entradas e saídas das camadas: só `transform`/`opacity`, curtas. */
const LAYER = "motion-safe:transition-[opacity,transform] motion-safe:duration-300 motion-safe:ease-out";

/**
 * No celular, Conversa e Você dividem o mesmo palco (mesma célula da grade) e
 * se alternam; a partir de `md` ficam lado a lado. Com movimento reduzido não
 * há alternância: os painéis ficam empilhados, todos à vista.
 */
const SHARED_STAGE = "motion-safe:[grid-area:1/1] md:motion-safe:[grid-area:auto]";
const OFFSTAGE = {
  left: "motion-safe:pointer-events-none motion-safe:-translate-x-3 motion-safe:opacity-0 md:motion-safe:pointer-events-auto md:motion-safe:translate-x-0 md:motion-safe:opacity-100",
  right:
    "motion-safe:pointer-events-none motion-safe:translate-x-3 motion-safe:opacity-0 md:motion-safe:pointer-events-auto md:motion-safe:translate-x-0 md:motion-safe:opacity-100",
} as const;

/** O que a cena mostra em cada passo (derivado só do passo atual). */
function sceneView(scene: SceneLoopState) {
  const id = scene.step?.id;
  // `saida` só existe com movimento: com movimento reduzido ele é o estado final, com tudo à vista.
  const leaving = id === "saida" && !scene.reduced;
  const chapter = MACHINE_CHAPTERS.reduce((last, c, i) => (scene.reached(c.from) ? i : last), -1);
  return {
    leaving,
    chapter,
    playingAudio: id === "audio",
    typing: id === "digitando" || id === "digitando-2",
    stageId: scene.reached("agendado") ? "agendado" : scene.reached("resposta") ? "interessado" : "novo",
    leadVisible: scene.reached("audio") && !leaving,
    notified: scene.reached("aviso") && !scene.reached("equipe"),
    pressing: id === "toque",
    taken: scene.reached("equipe") && !leaving,
    summary: scene.reached("resumo") && !leaving,
    /** Celular: o palco mostra "Você" a partir do aviso. */
    youOnStage: scene.reached("aviso") && !leaving,
  };
}

type SceneView = ReturnType<typeof sceneView>;

interface PanelProps {
  id: PanelId;
  children: ReactNode;
  /** Classes da caixa de altura reservada. */
  stageClassName: string;
  /** Esconde o rótulo no celular (o painel vira uma faixa). */
  compactLabel?: boolean;
  className?: string;
}

function Panel({ id, children, stageClassName, compactLabel = false, className }: PanelProps) {
  const meta = MACHINE_PANELS.find((p) => p.id === id)!;
  return (
    <div data-panel={id} className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className={cn("h-7 items-center justify-between gap-2 px-1", compactLabel ? "hidden md:flex" : "flex")}>
        <p className="font-display text-lg font-semibold text-text-primary">{meta.title}</p>
        <Badge variant="default">{meta.badge}</Badge>
      </div>
      <div data-stage-box="" className={stageClassName}>
        {children}
      </div>
    </div>
  );
}

function ConversationPanel({ scene, view }: { scene: SceneLoopState; view: SceneView }) {
  return (
    <ChatWindow
      title={T.customerName}
      subtitle="online"
      avatar={<Avatar name={T.customerName} size="md" />}
      className="h-full"
      bodyClassName="min-h-0 gap-0 overflow-hidden p-0"
    >
      <ChatFeed faded={view.leaving}>
        <Bubble variant="system">{T.dateSeparator}</Bubble>
        {scene.reached("audio") && (
          <AudioBubble
            variant="in"
            duration={T.audioDuration}
            time="23:14"
            playing={view.playingAudio}
            transcript={scene.reached("transcricao") ? MACHINE_TRANSCRIPT : undefined}
            enter
            // Largura já reservada para a transcrição: a bolha não alarga quando ela chega.
            className="[&>div]:w-[85%]"
          />
        )}
        {scene.reached("resposta") && (
          <Bubble variant="ai" label={T.aiLabel} time="23:14" ticks="read" enter>
            {T.aiPrice}
          </Bubble>
        )}
        {scene.reached("cliente-ok") && (
          <Bubble variant="in" time="23:15" enter>
            {T.customerOk}
          </Bubble>
        )}
        {scene.reached("ia-ok") && (
          <Bubble variant="ai" label={T.aiLabel} time="23:15" ticks="delivered" enter>
            {T.aiOk}
          </Bubble>
        )}
        {view.typing && <TypingDots variant="ai" className="motion-safe:animate-scene-in" />}
      </ChatFeed>
    </ChatWindow>
  );
}

function FunnelPanel({ view }: { view: SceneView }) {
  return (
    <div className="h-full rounded-card border border-border bg-surface-base p-1 shadow-card">
      <FunnelRail
        stages={MACHINE_FUNNEL_COLUMNS}
        cards={MACHINE_FUNNEL_CARDS}
        moving={{
          title: T.funnelCardTitle,
          subtitle: T.funnelCardSubtitle,
          stageId: view.stageId,
          visible: view.leadVisible,
        }}
        highlight
        className="md:h-full"
      />
    </div>
  );
}

function YouPanel({ scene, view }: { scene: SceneLoopState; view: SceneView }) {
  return (
    <PhoneFrame time={T.phoneClock} label={T.phoneLabel} className="h-full">
      {/* Repouso: nada pede você, a IA está atendendo. */}
      <div
        data-layer="repouso"
        className={cn(
          // O respiro de cima é o lugar onde o aviso pousa, sem cobrir o relógio.
          "absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 pt-32 text-center",
          LAYER,
          view.taken ? "scale-95 opacity-0" : "opacity-100"
        )}
      >
        <p className="font-display text-5xl font-semibold tabular-nums text-text-primary">{T.phoneClock}</p>
        <p className="mt-3 text-sm font-semibold text-text-primary">{T.restTitle}</p>
        <p className="text-sm text-text-secondary">{T.restBody}</p>
        <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-surface-sunken px-3 py-1 text-caption font-medium text-text-secondary">
          <span className="relative flex size-2">
            <span className="absolute inset-0 rounded-full bg-semantic-success motion-safe:animate-ping" />
            <span className="relative size-2 rounded-full bg-semantic-success" />
          </span>
          {T.restStatus}
        </p>
      </div>

      {/* Conversa assumida: toma a tela no lugar do repouso. */}
      <div
        data-layer="conversa-assumida"
        className={cn("absolute inset-0", LAYER, view.taken ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0")}
      >
        <ChatWindow
          title={T.customerName}
          subtitle="online"
          avatar={<Avatar name={T.customerName} size="md" />}
          className="h-full rounded-none border-0 shadow-none"
          bodyClassName="min-h-0 overflow-hidden"
        >
          {scene.reached("equipe") && (
            <>
              <Bubble variant="system" enter enterDelayMs={200}>
                {T.takeoverLine}
              </Bubble>
              <Bubble variant="out" label={T.teamLabel} time="23:16" ticks="sent" enter enterDelayMs={900}>
                {T.teamMessage}
              </Bubble>
            </>
          )}
        </ChatWindow>
      </div>

      {/* Resumo do Copiloto: sobe do pé da tela e fecha a cena. */}
      <div
        data-layer="resumo"
        className={cn("absolute inset-x-2 bottom-2", LAYER, view.summary ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0")}
      >
        <div className="rounded-card border border-border bg-surface-overlay p-3 shadow-elevated">
          <div className="flex items-center gap-2">
            <AiAvatar className="size-7 [&>svg]:size-4" />
            <p className="min-w-0 truncate text-caption">
              <span className="font-semibold text-text-primary">{T.copilotTitle}</span>
              <span className="text-text-muted"> · {T.copilotSubtitle}</span>
            </p>
          </div>
          <p className="mt-2 text-sm font-semibold text-text-primary">{T.copilotHeadline}</p>
          <ul className="mt-1 space-y-0.5 text-caption text-text-secondary">
            {T.copilotLeads.map((lead) => (
              <li key={lead} className="truncate">
                {lead}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Aviso: desce por cima do repouso e some quando você assume. */}
      <div
        data-layer="aviso"
        className={cn(
          "absolute inset-x-2 top-2 z-10",
          LAYER,
          view.notified
            ? "translate-y-0 opacity-100"
            : scene.reached("equipe")
              ? "scale-95 opacity-0"
              : "-translate-y-[130%] opacity-0"
        )}
      >
        <PhoneNotification
          title={T.notificationTitle}
          actions={[{ label: T.notificationLater }, { label: T.notificationTake, primary: true, pressed: view.pressing }]}
        />
      </div>
    </PhoneFrame>
  );
}

/**
 * Cena única em loop (~24 s): Conversa, Funil e Você. Todos os painéis têm
 * altura reservada desde o primeiro quadro (`STAGE_HEIGHT`) e a animação
 * acontece dentro deles, só com `transform`/`opacity`: a página não se mexe.
 *
 * - `md`+: três colunas de mesma altura (conversa maior, Funil em trilho
 *   vertical, celular).
 * - Celular: um palco só, em que a Conversa dá lugar ao painel Você quando o
 *   aviso chega, com o Funil numa faixa fina fixa logo abaixo.
 *
 * `SceneLoop` cuida da pausa (fora da tela e pelo botão, que fica no cabeçalho
 * da cena), do estado final com movimento reduzido e da descrição para leitor
 * de tela (a cena animada fica `aria-hidden`).
 */
export function S2Machine() {
  return (
    <LandingSection
      id={LANDING_ANCHORS.machine}
      eyebrow={MACHINE_EYEBROW}
      title={MACHINE_TITLE}
      subtitle={MACHINE_SUBTITLE}
      tone="raised"
    >
      <SceneLoop
        steps={MACHINE_STEPS}
        label={MACHINE_LABEL}
        description={MACHINE_DESCRIPTION}
        renderControl={false}
        header={(scene) => (
          <div data-scene-header="" className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2">
            <Badge variant="default" className="order-1">
              {MACHINE_BADGE}
            </Badge>
            <SceneSteps
              items={MACHINE_CHAPTERS}
              activeIndex={sceneView(scene).chapter}
              className="order-3 w-full md:order-2 md:w-auto md:max-w-xl md:flex-1"
            />
            {/* Lugar fixo do botão: a altura fica reservada mesmo sem ele (movimento reduzido). */}
            <div className="order-2 ml-auto flex h-11 items-center md:order-3">{scene.control}</div>
          </div>
        )}
      >
        {(scene) => {
          const view = sceneView(scene);
          return (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,5fr)_minmax(0,3fr)_minmax(0,4fr)] md:gap-4">
              <Panel
                id="conversa"
                stageClassName={STAGE_HEIGHT}
                className={cn(SHARED_STAGE, LAYER, view.youOnStage && OFFSTAGE.left)}
              >
                <ConversationPanel scene={scene} view={view} />
              </Panel>
              <Panel id="funil" stageClassName="md:h-[28rem]" compactLabel>
                <FunnelPanel view={view} />
              </Panel>
              <Panel
                id="voce"
                stageClassName={STAGE_HEIGHT}
                className={cn(SHARED_STAGE, LAYER, !view.youOnStage && OFFSTAGE.right)}
              >
                <YouPanel scene={scene} view={view} />
              </Panel>
            </div>
          );
        }}
      </SceneLoop>
      <p className="mt-4 max-w-2xl text-caption text-text-muted">{MACHINE_CAPTION}</p>
    </LandingSection>
  );
}
