import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { AiAvatar, ChatWindow } from "./ChatWindow";
import { Bubble } from "./Bubble";
import { TypingDots } from "./TypingDots";
import { AudioBubble } from "./AudioBubble";
import { AttachmentBubble } from "./AttachmentBubble";
import { Composer } from "./Composer";
import { RotatingPlaceholder } from "./RotatingPlaceholder";
import { ChipRow, type Chip } from "./ChipRow";
import { MiniFunnel } from "./MiniFunnel";
import { PhoneNotification } from "./PhoneNotification";
import { SceneLoop } from "./SceneLoop";
import { ChatFeed } from "./ChatFeed";
import { FunnelRail } from "./FunnelRail";
import { PhoneFrame } from "./PhoneFrame";
import { SceneSteps } from "./SceneSteps";
import type { SceneStep } from "./useSceneTimeline";

/**
 * Vitrine do kit de cena para revisão visual e para os próximos pacotes
 * (rota `/dev/kit`, montada só em DEV). Os textos vêm da copy aprovada da
 * landing; nada aqui vai para a página de produção.
 */

const PLACEHOLDERS = [
  "Tenho uma clínica de estética em Recife…",
  "instagram.com/minhaloja",
  "Sou corretor e perco lead fora do horário…",
  "Vou mandar o flyer do meu evento",
] as const;

const CHIPS: Chip[] = [
  { id: "clinica", label: "Clínica" },
  { id: "terapeuta", label: "Terapeuta" },
  { id: "corretor", label: "Corretor" },
  { id: "loja", label: "Loja" },
  { id: "eventos", label: "Eventos" },
  { id: "outro", label: "Outro" },
];

const CHIP_TEXT: Record<string, string> = {
  clinica: "Tenho uma clínica e quero atender os pacientes no WhatsApp",
  terapeuta: "Sou terapeuta e atendo online e presencial",
  corretor: "Sou corretor e perco lead fora do horário",
  loja: "Tenho uma loja e vendo pelo WhatsApp e pelo Instagram",
  eventos: "Organizo eventos e quero atender o público",
  outro: "",
};

const FUNNEL_COLUMNS = [
  { id: "novo", title: "Novo" },
  { id: "interessado", title: "Interessado" },
  { id: "agendado", title: "Agendado" },
];

const SCENE_STEPS: SceneStep[] = [
  { id: "inicio", duration: 900 },
  { id: "audio", duration: 1600 },
  { id: "digitando", duration: 1300 },
  { id: "resposta", duration: 2000 },
  { id: "cliente-ok", duration: 1500 },
  { id: "ia-ok", duration: 1800 },
  { id: "aviso", duration: 2200 },
  { id: "equipe", duration: 2400 },
  { id: "resumo", duration: 3500 },
];

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-display text-lg font-semibold text-text-primary">{title}</h2>
      {children}
    </section>
  );
}

export interface KitShowcaseProps {
  /** Força o movimento reduzido em todas as peças (revisão do estado final). */
  reducedMotion?: boolean;
}

export function KitShowcase({ reducedMotion }: KitShowcaseProps) {
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<string[]>([]);

  function send(text: string) {
    setSent((prev) => [...prev, text]);
    setDraft("");
  }

  return (
    <div className="space-y-10">
      <Panel title="Janela, composer e chips">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ChatWindow
            title="Copiloto HNBCRM"
            subtitle="online agora"
            badge={<Badge variant="brand">IA</Badge>}
            bodyClassName="min-h-[16rem]"
            composer={
              <Composer
                value={draft}
                onChange={setDraft}
                onSubmit={send}
                placeholder="Conte sobre o seu negócio"
                placeholders={PLACEHOLDERS}
                label="Mensagem para o Copiloto"
                attachLabel="Anexar arquivo (site, PDF ou imagem)"
                hint="O que você escrever aqui fica só no seu navegador até você criar a conta."
                reducedMotion={reducedMotion}
              />
            }
          >
            <Bubble variant="ai" side="start" label="Copiloto" time="09:41" enter>
              Oi! Me conta: o que você vende e como atende hoje?
            </Bubble>
            <Bubble variant="ai" side="start" label="Copiloto" time="09:41" tail={false} enter enterDelayMs={400}>
              Pode escrever, mandar um áudio, o link do site ou o flyer.
            </Bubble>
            {sent.map((text, i) => (
              <Bubble key={`sent:${i}`} variant="out" time="09:42" ticks="read" enter>
                {text}
              </Bubble>
            ))}
          </ChatWindow>
          <div className="space-y-4">
            <ChipRow
              className="-mx-4 px-4 md:mx-0 md:px-0"
              chips={CHIPS}
              label="Escolha o seu tipo de negócio"
              onSelect={(chip) => setDraft(CHIP_TEXT[chip.id] ?? "")}
            />
            <div className="rounded-card border border-border bg-surface-raised p-4 text-sm text-text-secondary">
              <p className="mb-2 font-medium text-text-primary">Placeholder rotativo sozinho</p>
              <RotatingPlaceholder phrases={PLACEHOLDERS} reducedMotion={reducedMotion} />
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Bolhas">
        <ChatWindow
          title="Marina"
          subtitle="online"
          typing
          avatar={<Avatar name="Marina" size="md" />}
          badge={<Badge variant="success">WhatsApp</Badge>}
        >
          <Bubble variant="system">Hoje</Bubble>
          <AudioBubble
            variant="in"
            duration="0:14"
            time="23:14"
            transcript="Oi, vocês têm horário no sábado? Queria saber o valor da limpeza de pele."
          />
          <Bubble variant="ai" label="Atendente IA" time="23:14" ticks="read">
            Oi, Marina! Sábado temos às 9h e às 10h30. A limpeza de pele sai por R$ 180. Qual horário você prefere?
          </Bubble>
          <AttachmentBubble variant="in" name="tabela-de-precos.pdf" meta="PDF · 2 páginas" kind="pdf" time="23:15" />
          <AttachmentBubble variant="ai" name="instagram.com/minhaloja" meta="Link" kind="link" time="23:15" ticks="delivered" />
          <Bubble variant="system">Você assumiu a conversa. A IA pausou.</Bubble>
          <Bubble variant="out" label="Ana" time="23:16" ticks="sent">
            Oi, Marina! Aqui é a Ana. Vou te passar o Pix do sinal.
          </Bubble>
          <TypingDots />
        </ChatWindow>
      </Panel>

      <Panel title="Funil e aviso no celular">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <MiniFunnel
            columns={FUNNEL_COLUMNS}
            cards={[
              { id: "paulo", title: "Paulo", subtitle: "pacote mensal", columnId: "novo" },
              { id: "ingrid", title: "Ingrid", subtitle: "voltou hoje", columnId: "interessado" },
            ]}
            moving={{ title: "Marina", subtitle: "limpeza de pele", columnId: "interessado" }}
            enter
          />
          <PhoneNotification
            title="Marina quer fechar. Assumir?"
            actions={[{ label: "Depois" }, { label: "Assumir", primary: true }]}
            enter
          />
        </div>
      </Panel>

      <Panel title="Palco de altura fixa (ChatFeed, FunnelRail, PhoneFrame, SceneSteps)">
        <SceneSteps
          items={[
            { id: "cliente", label: "Cliente chama" },
            { id: "ia", label: "IA responde" },
            { id: "funil", label: "Funil anda" },
            { id: "voce", label: "Você entra" },
          ]}
          activeIndex={1}
          className="mb-4 max-w-xl"
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,5fr)_minmax(0,3fr)_minmax(0,4fr)]">
          <ChatWindow
            title="Marina"
            subtitle="online"
            avatar={<Avatar name="Marina" size="md" />}
            className="h-80"
            bodyClassName="min-h-0 gap-0 overflow-hidden p-0"
          >
            <ChatFeed>
              <Bubble variant="system">Hoje</Bubble>
              <AudioBubble variant="in" duration="0:14" time="23:14" playing />
              <TypingDots variant="ai" />
            </ChatFeed>
          </ChatWindow>
          <div className="rounded-card border border-border bg-surface-base p-1 md:h-80">
            <FunnelRail
              stages={FUNNEL_COLUMNS}
              cards={[{ id: "paulo", title: "Paulo", subtitle: "pacote mensal", stageId: "novo" }]}
              moving={{ title: "Marina", subtitle: "limpeza de pele", stageId: "interessado" }}
              highlight
              className="md:h-full"
            />
          </div>
          <PhoneFrame time="23:14" className="h-80">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
              <p className="font-display text-4xl font-semibold tabular-nums text-text-primary">23:14</p>
              <p className="text-sm text-text-secondary">A IA está atendendo</p>
            </div>
          </PhoneFrame>
        </div>
      </Panel>

      <Panel title="Cena em loop (SceneLoop)">
        <SceneLoop
          steps={SCENE_STEPS}
          label="Cena ilustrativa: a máquina funcionando"
          description="Cena ilustrativa: às 23h14 uma cliente manda áudio perguntando horário e preço. A IA transcreve, responde, e o lead passa de Novo para Agendado no Funil. A dona recebe um aviso no celular, assume a conversa e manda o Pix."
          reducedMotion={reducedMotion}
        >
          {(scene) => (
            <div key={`ciclo:${scene.cycle}`} className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <ChatWindow
                title="Marina"
                subtitle="online"
                typing={scene.step?.id === "digitando"}
                avatar={<Avatar name="Marina" size="md" />}
                bodyClassName="h-80"
              >
                {scene.reached("audio") && <AudioBubble variant="in" duration="0:14" time="23:14" enter />}
                {scene.step?.id === "digitando" && <TypingDots />}
                {scene.reached("resposta") && (
                  <Bubble variant="ai" label="Atendente IA" time="23:14" ticks="read" enter>
                    Sábado temos às 9h e às 10h30. Qual horário você prefere?
                  </Bubble>
                )}
                {scene.reached("cliente-ok") && (
                  <Bubble variant="in" time="23:15" enter>
                    Fechado, 10h30!
                  </Bubble>
                )}
                {scene.reached("ia-ok") && (
                  <Bubble variant="ai" label="Atendente IA" time="23:15" ticks="delivered" tail={false} enter>
                    Anotei 10h30. A equipe confirma com você amanhã cedo.
                  </Bubble>
                )}
                {scene.reached("equipe") && (
                  <>
                    <Bubble variant="system" enter>
                      Você assumiu a conversa. A IA pausou.
                    </Bubble>
                    <Bubble variant="out" label="Ana" time="23:16" ticks="sent" enter>
                      Vou te passar o Pix do sinal.
                    </Bubble>
                  </>
                )}
              </ChatWindow>
              <MiniFunnel
                columns={FUNNEL_COLUMNS}
                moving={{
                  title: "Marina",
                  subtitle: "limpeza de pele",
                  columnId: scene.reached("ia-ok") ? "agendado" : scene.reached("resposta") ? "interessado" : "novo",
                }}
                enter
              />
              <div className="space-y-3">
                {scene.reached("aviso") && (
                  <PhoneNotification
                    title="Marina quer fechar. Assumir?"
                    actions={[{ label: "Depois" }, { label: "Assumir", primary: true }]}
                    enter
                  />
                )}
                {scene.reached("resumo") && (
                  <ChatWindow title="Copiloto" subtitle="resumo de hoje" avatar={<AiAvatar />}>
                    <Bubble variant="ai" side="start" label="Copiloto · resumo de hoje" enter>
                      <strong>3 leads quentes hoje</strong>
                      <br />
                      Marina · pronta para fechar
                    </Bubble>
                  </ChatWindow>
                )}
              </div>
            </div>
          )}
        </SceneLoop>
      </Panel>
    </div>
  );
}
