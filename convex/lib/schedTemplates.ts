/**
 * Agenda v2 — modelos prontos por tipo de negócio (§4.5 do plano). PURO: sem `ctx`, sem imports de
 * servidor, importável pelo front (o assistente do módulo mostra o rascunho e deixa editar).
 *
 * `buildTemplateDraft` só DEVOLVE o plano de criação (recursos, serviços, horários, padrões); quem
 * grava é `applySchedTemplateCore` (`schedConfigOps.ts`), que revalida o rascunho inteiro pelas
 * mesmas regras da edição manual. Recursos e serviços se ligam por `ref` (id só existe depois de
 * gravar).
 *
 * IA e interpretação da confirmação do humano não aparecem aqui de propósito: os padrões de
 * `resolveSchedSettings` já são "consulta e reserva para você aprovar" e "marcar sozinho".
 */

export const SCHED_TEMPLATE_KEYS = ["clinic", "solo", "barber", "consulting"] as const;
export type SchedTemplateKey = (typeof SCHED_TEMPLATE_KEYS)[number];

export const SCHED_TEMPLATE_LABELS: Record<SchedTemplateKey, { title: string; description: string }> = {
  clinic: { title: "Clínica com salas", description: "Salas (uma dupla) e profissionais; cada sessão ocupa uma sala e um profissional." },
  solo: { title: "Profissional solo", description: "Só você atende, com um intervalo depois de cada atendimento." },
  barber: { title: "Barbearia ou salão", description: "Vários profissionais; o cliente escolhe com quem marcar." },
  consulting: { title: "Consultoria ou advocacia", description: "Reuniões com intervalo e aviso de 24 horas de antecedência." },
};

/** Máximo de profissionais criados a partir da equipe. */
export const TEMPLATE_MAX_PEOPLE = 6;

export type TemplateResourceKind = "person" | "room" | "equipment";
export type TemplateWeekly = Array<{ weekday: number; startMin: number; endMin: number }>;

export type TemplateResourceDraft = {
  ref: string;
  kind: TemplateResourceKind;
  name: string;
  capacity: number;
  teamMemberId?: string;
  weekly: TemplateWeekly;
  tags?: string[];
};
export type TemplateServiceDraft = {
  name: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  slotIntervalMin?: number;
  aiBookable?: boolean;
  requirements: Array<{
    role: string;
    kind: TemplateResourceKind;
    /** `ref`s de `resources`; ausente/vazio = qualquer recurso ativo do tipo. */
    resourceRefs?: string[];
    tag?: string;
    units?: number;
    exclusive?: boolean;
  }>;
};
export type SchedTemplateDraft = {
  templateKey: string;
  settings: { gridMinutes: number; smartMode?: "off" | "rank" | "restrict"; minNoticeMin?: number };
  resources: TemplateResourceDraft[];
  services: TemplateServiceDraft[];
};

export type TemplateMember = { id: string; name: string };
export type TemplateInput = {
  /** Membros humanos ativos da org, em ordem estável. */
  members: TemplateMember[];
  /** Quem está configurando (modelo "solo"); ausente = o primeiro da lista. */
  configuringMemberId?: string;
};

export function isSchedTemplateKey(key: string): key is SchedTemplateKey {
  return (SCHED_TEMPLATE_KEYS as readonly string[]).includes(key);
}

/** Mesmos turnos nos dias da semana informados (0 = domingo). */
function week(weekdays: number[], shifts: Array<[number, number]>): TemplateWeekly {
  const out: TemplateWeekly = [];
  for (const weekday of weekdays) for (const [startMin, endMin] of shifts) out.push({ weekday, startMin, endMin });
  return out;
}
const h = (hours: number, minutes = 0) => hours * 60 + minutes;

function uniqueName(base: string, used: Set<string>): string {
  const clean = base.trim().slice(0, 60) || "Profissional";
  let name = clean;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${clean.slice(0, 56)} ${n}`;
  used.add(name.toLowerCase());
  return name;
}

function people(members: TemplateMember[], weekly: TemplateWeekly, limit: number, used: Set<string>): TemplateResourceDraft[] {
  return members.slice(0, limit).map((m, i) => ({
    ref: `person-${i + 1}`,
    kind: "person" as const,
    name: uniqueName(m.name, used),
    capacity: 1,
    teamMemberId: m.id,
    weekly: weekly.map((w) => ({ ...w })),
  }));
}

/** O plano de criação do modelo. Puro e determinístico (mesma entrada, mesmo rascunho). */
export function buildTemplateDraft(key: SchedTemplateKey, input: TemplateInput): SchedTemplateDraft {
  const members = input.members;
  const used = new Set<string>();
  switch (key) {
    case "clinic": {
      const weekly = [...week([1, 2, 3, 4, 5], [[h(9), h(12)], [h(14), h(18)]]), ...week([6], [[h(9), h(12)]])];
      const rooms: TemplateResourceDraft[] = [
        { ref: "room-1", kind: "room", name: uniqueName("Sala 1", used), capacity: 1, weekly },
        { ref: "room-2", kind: "room", name: uniqueName("Sala 2", used), capacity: 1, weekly },
        { ref: "room-dual", kind: "room", name: uniqueName("Sala dupla", used), capacity: 2, weekly },
      ];
      const requirements = [
        { role: "Sala", kind: "room" as const, units: 1 },
        { role: "Profissional", kind: "person" as const },
      ];
      return {
        templateKey: key,
        settings: { gridMinutes: 30, smartMode: "rank" },
        resources: [...rooms, ...people(members, weekly, TEMPLATE_MAX_PEOPLE, used)],
        services: [
          { name: "Sessão", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, requirements },
          { name: "Avaliação", durationMin: 45, bufferBeforeMin: 0, bufferAfterMin: 0, requirements },
        ],
      };
    }
    case "solo": {
      const who = members.find((m) => m.id === input.configuringMemberId) ?? members[0];
      const weekly = week([1, 2, 3, 4, 5], [[h(9), h(12)], [h(13), h(18)]]);
      return {
        templateKey: key,
        settings: { gridMinutes: 60 },
        resources: who ? people([who], weekly, 1, used) : [],
        services: [
          {
            name: "Atendimento",
            durationMin: 50,
            bufferBeforeMin: 0,
            bufferAfterMin: 10,
            requirements: [{ role: "Profissional", kind: "person" }],
          },
        ],
      };
    }
    case "barber": {
      const weekly = week([2, 3, 4, 5, 6], [[h(9), h(19)]]);
      const req = [{ role: "Profissional", kind: "person" as const }];
      return {
        templateKey: key,
        settings: { gridMinutes: 30 },
        resources: people(members, weekly, TEMPLATE_MAX_PEOPLE, used),
        services: [
          { name: "Corte", durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, requirements: req },
          { name: "Barba", durationMin: 20, bufferBeforeMin: 0, bufferAfterMin: 0, requirements: req },
          { name: "Corte e barba", durationMin: 50, bufferBeforeMin: 0, bufferAfterMin: 0, requirements: req },
        ],
      };
    }
    case "consulting": {
      const who = members.find((m) => m.id === input.configuringMemberId) ?? members[0];
      const weekly = week([1, 2, 3, 4, 5], [[h(9), h(18)]]);
      const req = [{ role: "Profissional", kind: "person" as const }];
      return {
        templateKey: key,
        settings: { gridMinutes: 30, minNoticeMin: 24 * 60 },
        resources: who ? people([who], weekly, 1, used) : [],
        services: [
          { name: "Reunião", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 15, requirements: req },
          { name: "Diagnóstico", durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, requirements: req },
        ],
      };
    }
  }
}
