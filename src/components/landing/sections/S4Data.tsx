import type { ReactNode } from "react";
import { Bubble, AttachmentBubble, MiniFunnel, PhoneNotification } from "../kit";
import { Building2, Globe, Megaphone, Users } from "lucide-react";
import { HelpRequest, SceneBox, SceneChip, SceneTag } from "./S3Parts";

/** Perfis, dores e cenas da seção S4 (copy aprovada em 11/11/2026). As cenas são exemplos (a seção avisa uma vez, no rodapé). */

export interface ProfilePain {
  today: string;
  with: string;
  /** Nome acessível da cena. */
  sceneLabel: string;
  scene: ReactNode;
}

export interface ProfileTab {
  id: string;
  label: string;
  pains: readonly ProfilePain[];
  /** Nota fixa da aba (o que ainda não existe). */
  note?: string;
}

const FUNNEL_COLUMNS = [
  { id: "novo", title: "Novo" },
  { id: "qualificado", title: "Qualificado" },
  { id: "visita", title: "Visita marcada" },
] as const;

const FUNNEL_CARDS = [
  { id: "c1", title: "Camila", columnId: "novo" },
  { id: "c2", title: "Diego", columnId: "novo" },
  { id: "c3", title: "Bia", columnId: "novo" },
  { id: "c4", title: "Tomás", columnId: "novo" },
  { id: "c5", title: "Rafael", subtitle: "2 quartos · financiamento", columnId: "qualificado" },
  { id: "c6", title: "Helena", columnId: "qualificado" },
  { id: "c7", title: "Lúcia", subtitle: "Visita sábado, 10h", columnId: "visita" },
  { id: "c8", title: "Marcos", subtitle: "Cobertura · à vista", columnId: "visita" },
] as const;

const UNIT_BARS = [
  { name: "Centro", count: 52 },
  { name: "Norte", count: 41 },
  { name: "Sul", count: 35 },
] as const;

/** Mini-painel da Central (números ilustrativos): três KPIs e conversas por unidade. */
function CentralPanel() {
  const max = Math.max(...UNIT_BARS.map((u) => u.count));
  return (
    <div className="flex flex-col justify-center rounded-card border border-border-subtle bg-surface-raised p-3 shadow-card">
      <p className="flex items-center justify-between gap-2 text-sm font-semibold text-text-primary">
        Central
        <span className="text-caption font-normal text-text-muted">números ilustrativos</span>
      </p>
      <dl className="mt-3 grid grid-cols-3 gap-2">
        {[
          ["Primeira resposta", "1 min 40 s"],
          ["Conversas hoje", "128"],
          ["Convertidas", "31%"],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-field bg-surface-sunken p-2">
            <dt className="text-caption leading-tight text-text-muted">{label}</dt>
            <dd className="mt-1 text-base font-semibold tabular-nums leading-tight text-text-primary">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-caption font-semibold text-text-secondary">Conversas por unidade</p>
      <ul className="mt-1.5 space-y-2">
        {UNIT_BARS.map((u) => (
          <li key={u.name} className="grid grid-cols-[3.25rem_1fr_2rem] items-center gap-2 text-caption">
            <span className="text-text-secondary">{u.name}</span>
            <span aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
              <span className="block h-full rounded-full bg-brand-600" style={{ width: `${Math.round((u.count / max) * 100)}%` }} />
            </span>
            <span className="text-right font-semibold tabular-nums text-text-primary">{u.count}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-caption text-text-secondary">Atendidas pelo time: IA e equipe juntas.</p>
    </div>
  );
}

export const PROFILE_TABS: readonly ProfileTab[] = [
  {
    id: "clinica",
    label: "Clínica e consultório",
    pains: [
      {
        today: "Paciente chama às 22h e só tem resposta no dia seguinte.",
        with: "O Atendente responde na hora, do jeito da sua clínica, e a recepção confirma o horário.",
        sceneLabel: "Exemplo: paciente pergunta o preço à noite",
        scene: (
          <SceneBox>
            <Bubble variant="in" label="Paciente" time="22:07" enter>
              Quanto custa a consulta com a dermatologista?
            </Bubble>
            <Bubble variant="ai" label="Atendente IA" time="22:07" enter enterDelayMs={400}>
              A consulta é R$ 350. Qual dia e período ficam melhor para você? A recepção confirma o horário amanhã cedo.
            </Bubble>
          </SceneBox>
        ),
      },
      {
        today: "A recepção atende telefone, balcão e WhatsApp ao mesmo tempo.",
        with: "Quando a IA não sabe, ela passa para a recepção com o resumo da conversa pronto.",
        sceneLabel: "Exemplo: pedido de ajuda para a recepção",
        scene: (
          <SceneBox>
            <HelpRequest title="Carla quer saber se o convênio cobre o procedimento" enter />
            <Bubble variant="out" label="Recepção" time="10:31" enter enterDelayMs={400}>
              Assumi. Vou conferir com o convênio e já te respondo.
            </Bubble>
          </SceneBox>
        ),
      },
      {
        today: "Quem pediu orçamento some, e ninguém lembra de voltar a falar.",
        with: "A IA volta a falar com quem sumiu e, antes de mandar, lê a conversa de novo. Se o cliente já resolveu, ela não manda.",
        sceneLabel: "Exemplo: retorno agendado pela IA",
        scene: (
          <SceneBox>
            <Bubble variant="system" enter>
              Retorno agendado pela IA · quinta, 10h
            </Bubble>
            <Bubble variant="ai" label="Atendente IA" time="quinta, 10:00" enter enterDelayMs={400}>
              Oi, Bruno! Ficou alguma dúvida sobre o orçamento do clareamento?
            </Bubble>
          </SceneBox>
        ),
      },
    ],
  },
  {
    id: "terapeuta",
    label: "Terapeuta e autônomo",
    pains: [
      {
        today: "A mensagem chega no meio da sessão, e o cliente desiste de esperar.",
        with: "A IA escreve a resposta e você aprova com um toque quando sair da sessão.",
        sceneLabel: "Exemplo: sugestão da IA para aprovar",
        scene: (
          <SceneBox>
            <Bubble variant="in" label="Cliente" time="15:20" enter>
              Oi! Você atende online? Qual o valor?
            </Bubble>
            <Bubble variant="ai" label="Sugestão da IA" time="15:20" enter enterDelayMs={400}>
              Atendo online e presencial. A sessão é R$ 150. Quer que eu te passe os horários?
              <br />
              <SceneTag>Aprovar</SceneTag>
            </Bubble>
          </SceneBox>
        ),
      },
      {
        today: "O comprovante do Pix se perde no meio da conversa.",
        with: "O cliente manda o print e a IA lê. Quem confirma o pagamento é você.",
        sceneLabel: "Exemplo: comprovante enviado pelo cliente",
        scene: (
          <SceneBox>
            <AttachmentBubble variant="in" kind="image" name="comprovante.jpg" label="Cliente" time="18:02" enter />
            <Bubble variant="ai" label="Atendente IA" time="18:02" enter enterDelayMs={400}>
              Recebi o seu comprovante de R$ 150. A Júlia confirma o pagamento e te avisa.
            </Bubble>
          </SceneBox>
        ),
      },
      {
        today: "Você só vê o que ficou pendente quando abre o computador.",
        with: "No Telegram, você recebe os pedidos de ajuda e o resumo do dia, e resolve dali mesmo.",
        sceneLabel: "Exemplo: aviso do Copiloto no Telegram",
        scene: (
          <SceneBox className="justify-center">
            <PhoneNotification
              app="Telegram"
              time="08:00"
              title="Copiloto"
              body="Bom dia. Dois pedidos de ajuda esperam por você e há um retorno para hoje."
              actions={[{ label: "Aceitar", primary: true }, { label: "Instruir a IA" }]}
              enter
            />
          </SceneBox>
        ),
      },
    ],
  },
  {
    id: "corretor",
    label: "Corretor e imobiliária",
    note: "Estamos construindo com corretores: distribuição automática de leads e envio de book e planta ainda não existem.",
    pains: [
      {
        today: "O lead do anúncio chega à noite e esfria até de manhã.",
        with: "O Atendente responde no primeiro minuto e já pergunta valor, prazo e financiamento.",
        sceneLabel: "Exemplo: lead do anúncio à noite",
        scene: (
          <SceneBox>
            <div className="flex flex-wrap gap-1.5">
              <SceneChip icon={Megaphone}>Anúncio · Apto 2 quartos</SceneChip>
            </div>
            <Bubble variant="in" label="Cliente" time="21:40" enter>
              Vi o apartamento de 2 quartos. Podemos conversar?
            </Bubble>
            <Bubble variant="ai" label="Atendente IA" time="21:40" enter enterDelayMs={400}>
              Claro, Rafael! Para eu te ajudar melhor: você pensa em financiar? E para quando seria a mudança?
            </Bubble>
            <Bubble variant="in" label="Cliente" time="21:42" enter enterDelayMs={800}>
              Vou financiar, sim. A mudança seria em uns 3 meses.
            </Bubble>
          </SceneBox>
        ),
      },
      {
        today: "O lead some depois do primeiro contato.",
        with: "A IA volta a falar na data certa e não manda se o lead já resolveu.",
        sceneLabel: "Exemplo: retorno ao lead na segunda",
        scene: (
          <SceneBox>
            <Bubble variant="system" enter>
              Retorno agendado pela IA · Rafael · segunda, 10h
            </Bubble>
            <Bubble variant="ai" label="Atendente IA" time="segunda, 10:00" enter enterDelayMs={400}>
              Oi, Rafael! Conseguiu ver a simulação do financiamento?
            </Bubble>
            <Bubble variant="in" label="Rafael" time="10:12" enter enterDelayMs={800}>
              Vi sim! Pode marcar uma visita no sábado?
            </Bubble>
          </SceneBox>
        ),
      },
      {
        today: "Você não sabe em que pé está cada lead.",
        with: "Cada lead na sua etapa do Funil, com a conversa junto. Você vê quem espera visita e quem ainda precisa de resposta.",
        sceneLabel: "Exemplo: Funil com leads",
        scene: <MiniFunnel columns={FUNNEL_COLUMNS} cards={FUNNEL_CARDS} enter label="Funil de exemplo" className="h-full [&>div]:h-full [&>div>div]:min-h-[12rem]" />,
      },
    ],
  },
  {
    id: "comunidade",
    label: "Comunidade e eventos",
    pains: [
      {
        today: "Os grupos de WhatsApp ficam parados durante a semana.",
        with: "Publicações programadas nos grupos, com texto seu ou mensagem do dia escrita pela IA, com aprovação se você quiser. Só na conexão por QR code.",
        sceneLabel: "Exemplo: mensagem do dia no grupo",
        scene: (
          <SceneBox>
            <div className="flex flex-wrap gap-1.5">
              <SceneChip icon={Users}>Grupo · Roda de conversa</SceneChip>
            </div>
            <Bubble variant="system" enter>
              Publicação programada · 07:30
            </Bubble>
            <Bubble variant="ai" label="Mensagem do dia" time="07:30" enter enterDelayMs={400}>
              Bom dia! Sábado tem roda de conversa às 16h. Traga quem você quiser.
            </Bubble>
            <Bubble variant="in" label="Marina" time="07:41" enter enterDelayMs={800}>
              Eu vou! Levo a Paula junto.
            </Bubble>
          </SceneBox>
        ),
      },
      {
        today: "Toda hora alguém pergunta a data do próximo encontro.",
        with: "No grupo, a IA só responde quando é mencionada. Ela consulta a agenda que você indicar e manda o flyer.",
        sceneLabel: "Exemplo: a IA responde no grupo quando é mencionada",
        scene: (
          <SceneBox>
            <div className="flex flex-wrap gap-1.5">
              <SceneChip icon={Users}>Grupo · Roda de conversa</SceneChip>
            </div>
            <Bubble variant="in" label="Membro do grupo" time="12:15" enter>
              @Assistente quando é o próximo encontro?
            </Bubble>
            <Bubble variant="ai" label="Atendente IA" time="12:15" enter enterDelayMs={400}>
              Dia 22, às 19h, no espaço de sempre. Quer que eu mande o flyer?
            </Bubble>
            <Bubble variant="in" label="Membro do grupo" time="12:16" enter enterDelayMs={800}>
              Quero, obrigado!
            </Bubble>
          </SceneBox>
        ),
      },
      {
        today: "Quem se inscreve pelo site fica sem resposta.",
        with: "O formulário do site cria o lead no Funil, e as boas-vindas saem no WhatsApp.",
        sceneLabel: "Exemplo: boas-vindas após inscrição pelo site",
        scene: (
          <SceneBox>
            <div className="flex flex-wrap gap-1.5">
              <SceneChip icon={Globe}>Formulário do site</SceneChip>
            </div>
            <Bubble variant="system" enter>
              Lead novo no Funil · Patrícia
            </Bubble>
            <Bubble variant="ai" label="Atendente IA" time="09:03" enter enterDelayMs={400}>
              Oi, Patrícia! Recebi sua inscrição. Posso te mandar os detalhes do encontro?
            </Bubble>
            <Bubble variant="in" label="Patrícia" time="09:05" enter enterDelayMs={800}>
              Pode sim! Estou ansiosa.
            </Bubble>
          </SceneBox>
        ),
      },
    ],
  },
  {
    id: "rede",
    label: "Rede com várias unidades",
    pains: [
      {
        today: "Cada unidade atende de um jeito.",
        with: "Unidade e departamento em cada conversa, com fila e transferência com nota.",
        sceneLabel: "Exemplo: conversa transferida entre departamentos",
        scene: (
          <SceneBox>
            <div className="flex flex-wrap gap-1.5">
              <SceneChip icon={Building2}>Unidade Centro</SceneChip>
              <SceneChip>Departamento Reservas</SceneChip>
            </div>
            <Bubble variant="in" label="Hóspede" time="18:20" enter>
              Vou chegar só às 23h. Tem problema?
            </Bubble>
            <Bubble variant="system" enter enterDelayMs={400}>
              Transferida para Recepção, com a nota "Hóspede chega às 23h."
            </Bubble>
            <Bubble variant="out" label="Recepção" time="18:24" enter enterDelayMs={800}>
              Tudo certo, já vi a nota. Deixamos o seu check-in pronto para as 23h.
            </Bubble>
          </SceneBox>
        ),
      },
      {
        today: "O gestor não enxerga a operação.",
        with: "A Central mostra a primeira resposta, as conversas por unidade e por departamento e quantas foram convertidas.",
        sceneLabel: "Exemplo: painel Central",
        scene: <CentralPanel />,
      },
      {
        today: "O hóspede escreve em outro idioma.",
        with: "A equipe lê e responde em português. A mensagem sai no idioma do cliente. Tradução automática é módulo opcional.",
        sceneLabel: "Exemplo: tradução automática",
        scene: (
          <SceneBox>
            <div className="flex flex-wrap gap-1.5">
              <SceneChip icon={Globe}>Idioma · inglês</SceneChip>
            </div>
            <Bubble variant="in" label="Cliente" time="20:40" enter>
              Hi! Do you have a room for two this Friday?
              <span className="mt-1 block border-t border-border-subtle pt-1 text-caption text-text-secondary">
                <span className="font-semibold">Traduzido:</span> Oi! Vocês têm quarto para dois nesta sexta?
              </span>
            </Bubble>
            <Bubble variant="out" label="Equipe" time="20:41" enter enterDelayMs={400}>
              Temos, sim. Quer que eu reserve?
              <br />
              <SceneTag>Sai em inglês</SceneTag>
            </Bubble>
          </SceneBox>
        ),
      },
    ],
  },
];
