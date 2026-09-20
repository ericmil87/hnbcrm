import { describe, expect, it } from "vitest";
import {
  FOLLOW_UP_REASON_LABELS,
  FOLLOW_UP_STATUS_LABELS,
  formatFollowUpDueAt,
  followUpBadgeTone,
  followUpHeadline,
  humanizeFollowUpReason,
  type FollowUpStatus,
} from "./followUp";

describe("humanizeFollowUpReason", () => {
  it("traduz um código reconhecido", () => {
    expect(humanizeFollowUpReason("ia_pausada")).toBe("a conversa está com um humano");
    expect(humanizeFollowUpReason("janela_24h")).toBe("a janela de 24h do WhatsApp está fechada");
  });

  it("traduz um código que só escapa cru do runNow (não coberto por describeFollowUpReason no servidor)", () => {
    expect(humanizeFollowUpReason("opt_out")).toBe(
      "o contato pediu para não receber mensagens"
    );
    expect(humanizeFollowUpReason("fora_da_janela")).toBe("fora da janela de envio configurada");
    expect(humanizeFollowUpReason("remarcado")).toBe(
      "o prazo foi alterado enquanto o follow-up esperava"
    );
  });

  it("devolve uma frase já humana (vinda pronta do backend) sem alterar", () => {
    const frase = "A tarefa passou a ser de outro responsável";
    expect(humanizeFollowUpReason(frase)).toBe(frase);
  });

  it("devolve um código desconhecido como veio, em vez de esconder a informação", () => {
    expect(humanizeFollowUpReason("codigo_novo_ainda_nao_mapeado")).toBe(
      "codigo_novo_ainda_nao_mapeado"
    );
  });

  it("null/undefined/vazio viram null", () => {
    expect(humanizeFollowUpReason(null)).toBeNull();
    expect(humanizeFollowUpReason(undefined)).toBeNull();
    expect(humanizeFollowUpReason("   ")).toBeNull();
    expect(humanizeFollowUpReason("")).toBeNull();
  });
});

describe("FOLLOW_UP_STATUS_LABELS", () => {
  it("cobre os 7 status do ciclo de vida do follow-up", () => {
    const statuses = [
      "scheduled",
      "queued",
      "drafted",
      "done",
      "not_needed",
      "needs_human",
      "canceled",
    ] as const;
    for (const status of statuses) {
      expect(FOLLOW_UP_STATUS_LABELS[status]).toBeTruthy();
    }
  });
});

describe("FOLLOW_UP_REASON_LABELS", () => {
  it("nenhum rótulo fica vazio", () => {
    for (const [code, label] of Object.entries(FOLLOW_UP_REASON_LABELS)) {
      expect(label.trim().length, `código "${code}" sem rótulo`).toBeGreaterThan(0);
    }
  });
});

describe("formatFollowUpDueAt", () => {
  const now = new Date(2026, 8, 19, 14, 32).getTime(); // sáb 19/09/2026 14:32 local

  it("hoje mostra 'hoje HH:MM'", () => {
    expect(formatFollowUpDueAt(new Date(2026, 8, 19, 9, 5).getTime(), now)).toBe("hoje 09:05");
  });

  it("amanhã mostra 'amanhã HH:MM'", () => {
    expect(formatFollowUpDueAt(new Date(2026, 8, 20, 9, 0).getTime(), now)).toBe("amanhã 09:00");
  });

  it("outro dia mostra 'dia_da_semana dd/mm HH:MM'", () => {
    expect(formatFollowUpDueAt(new Date(2026, 8, 26, 15, 0).getTime(), now)).toBe(
      "sáb 26/09 15:00"
    );
  });

  it("virada de mês formata dd/mm corretamente", () => {
    expect(formatFollowUpDueAt(new Date(2026, 9, 2, 8, 0).getTime(), now)).toBe("sex 02/10 08:00");
  });
});

const ALL_STATUSES: FollowUpStatus[] = [
  "scheduled",
  "queued",
  "drafted",
  "done",
  "not_needed",
  "needs_human",
  "canceled",
];

describe("followUpHeadline", () => {
  it("todo status tem uma manchete não vazia", () => {
    for (const status of ALL_STATUSES) {
      expect(followUpHeadline(status, Date.now()).trim().length).toBeGreaterThan(0);
    }
  });

  it("scheduled inclui o horário formatado", () => {
    const now = new Date(2026, 8, 19, 14, 32).getTime();
    const dueAt = new Date(2026, 8, 20, 9, 0).getTime();
    expect(followUpHeadline("scheduled", dueAt, now)).toBe("A IA executa em amanhã 09:00");
  });
});

describe("followUpBadgeTone", () => {
  it("todo status resolve para um tom válido do Badge", () => {
    const validTones = new Set(["default", "brand", "success", "error", "warning", "info"]);
    for (const status of ALL_STATUSES) {
      expect(validTones.has(followUpBadgeTone(status))).toBe(true);
    }
  });

  it("needs_human usa o tom de alerta", () => {
    expect(followUpBadgeTone("needs_human")).toBe("warning");
  });
});
