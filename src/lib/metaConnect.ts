// Cópias PT-BR e estados da conexão Instagram / Messenger (Meta Messaging).
// Puro: sem React, sem Convex.

export const STANDARD_ACCESS_NOTICE =
  "Por enquanto este canal só funciona para contas em que o HNBCRM tem papel de teste. Fale com o suporte para liberar a sua.";

export const DEFAULT_APP_HINT =
  "Defina o HNBCRM como app padrão em Configurações da Página > Mensagens avançadas.";

export const MODULE_OFF_CONFIRMATION =
  "Mensagens recebidas enquanto o módulo estiver desligado não entram no HNBCRM.";

export type MetaReturnKind = "success" | "info" | "error";

export interface MetaReturnMessage {
  kind: MetaReturnKind;
  text: string;
}

const MESSAGES: Record<string, MetaReturnMessage> = {
  ok: { kind: "success", text: "Conta conectada com sucesso." },
  cancelado: { kind: "info", text: "Conexão cancelada. Nada foi alterado." },
  expirado: { kind: "error", text: "A conexão expirou. Tente conectar novamente." },
  conta_em_uso: { kind: "error", text: "Esta conta já está conectada a outra organização." },
  sem_permissao: {
    kind: "error",
    text: "Algumas permissões não foram concedidas. Conecte novamente e aceite todas as permissões solicitadas.",
  },
  sem_pagina: {
    kind: "error",
    text: "Nenhuma Página do Facebook com permissão de mensagens foi encontrada. É preciso ter uma Página com a conta do Instagram vinculada.",
  },
  sem_papel: { kind: "error", text: STANDARD_ACCESS_NOTICE },
  modulo_off: {
    kind: "error",
    text: "Ative o módulo \"Mais canais: Instagram e Facebook Messenger\" antes de conectar.",
  },
  falha_meta: {
    kind: "error",
    text: "Não foi possível concluir a conexão com a Meta. Tente novamente em instantes.",
  },
};

const FALLBACK: MetaReturnMessage = {
  kind: "error",
  text: "Não foi possível conectar a conta. Tente novamente.",
};

/**
 * Mensagem do código `?meta=` / `{ok:false, code}`. `selecionar` não tem
 * mensagem (abre a seleção de Páginas); código desconhecido vira erro genérico.
 * `reconnecting` = a volta veio de um "Reconectar" (e não de uma conexão nova).
 */
export function metaReturnMessage(code: string, reconnecting = false): MetaReturnMessage | null {
  if (code === "selecionar") return null;
  if (code === "ok" && reconnecting) return { kind: "success", text: "Conexão renovada." };
  return MESSAGES[code] ?? FALLBACK;
}

export type MetaAuthState = "ok" | "reauth_required" | "revoked";

export interface MetaConnectionStateInput {
  metaAuthState: MetaAuthState | null;
  metaSubscribed: boolean | null;
  disabledByModuleAt: number | null;
  /** "data_access_expiring" = acesso aos dados expira em menos de 14 dias. */
  metaAuthDetail?: string | null;
  metaDataAccessExpiresAt?: number | null;
}

export interface MetaConnectionState {
  label: string;
  variant: "success" | "warning" | "error" | "default";
}

/** Estado exibido no card do canal Meta. */
export function metaConnectionState(c: MetaConnectionStateInput): MetaConnectionState {
  if (c.metaAuthState === "revoked") return { label: "Desconectado", variant: "error" };
  if (c.metaAuthState === "reauth_required") return { label: "Precisa reconectar", variant: "warning" };
  if (c.disabledByModuleAt != null) return { label: "Desativado pelo módulo", variant: "default" };
  if (c.metaSubscribed === false) return { label: "Conexão incompleta", variant: "warning" };
  if (c.metaAuthState === "ok") return { label: "Conectado", variant: "success" };
  return { label: "Desconectado", variant: "default" };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const REAUTH_DEFAULT_DETAIL =
  "A Meta invalidou a credencial: senha trocada, app revogado ou papel perdido.";

const AUTH_DETAIL_TEXT: Record<string, string> = {
  data_access_expiring: "O acesso aos dados desta conta está perto de expirar.",
  token_invalid: REAUTH_DEFAULT_DETAIL,
};

/** Texto humano do `metaAuthDetail`; detalhe desconhecido cai na explicação padrão. */
export function humanizeAuthDetail(detail: string | null | undefined): string {
  if (!detail) return REAUTH_DEFAULT_DETAIL;
  return AUTH_DETAIL_TEXT[detail] ?? REAUTH_DEFAULT_DETAIL;
}

/** Dias inteiros (arredondados para cima) até `expiresAt`; null sem data; 0 se já passou. */
export function daysUntil(expiresAt: number | null | undefined, now: number): number | null {
  if (expiresAt == null) return null;
  return Math.max(0, Math.ceil((expiresAt - now) / DAY_MS));
}

/** Dias restantes quando o acesso está expirando (< 14 dias); senão null. */
export function expiringDays(c: MetaConnectionStateInput, now: number): number | null {
  if (c.metaAuthState !== "ok") return null;
  const days = daysUntil(c.metaDataAccessExpiresAt, now);
  if (c.metaAuthDetail === "data_access_expiring") return days ?? 0;
  return days != null && days < 14 ? days : null;
}

/** "Verificado há 3h" a partir de `metaLastHealthAt`; null sem verificação. */
export function verifiedAgoLabel(ts: number | null | undefined, now: number): string | null {
  if (ts == null) return null;
  const min = Math.max(0, Math.round((now - ts) / 60_000));
  if (min < 1) return "Verificado agora";
  if (min < 60) return `Verificado há ${min}min`;
  const h = Math.round(min / 60);
  if (h < 24) return `Verificado há ${h}h`;
  return `Verificado há ${Math.round(h / 24)}d`;
}

export type MetaCardAction = "reconnect" | "complete";

export interface MetaCardView {
  /** Botão de destaque; null quando não há nada a fazer. */
  action: MetaCardAction | null;
  actionLabel: string | null;
  /** Faixa de aviso sob o cabeçalho. */
  notice: { tone: "warning" | "error"; text: string } | null;
}

/** Ação principal e faixa de aviso do card, por estado da conexão. */
export function metaCardView(c: MetaConnectionStateInput, now: number): MetaCardView {
  if (c.metaAuthState === "revoked") {
    return { action: "reconnect", actionLabel: "Conectar de novo", notice: null };
  }
  if (c.metaAuthState === "reauth_required") {
    return {
      action: "reconnect",
      actionLabel: "Reconectar",
      notice: { tone: "warning", text: humanizeAuthDetail(c.metaAuthDetail) },
    };
  }
  if (c.disabledByModuleAt != null) return { action: null, actionLabel: null, notice: null };
  if (c.metaSubscribed === false) {
    return {
      action: "complete",
      actionLabel: "Concluir conexão",
      notice: {
        tone: "warning",
        text: "A conexão não foi concluída e as mensagens ainda não chegam. Conclua para ativar o recebimento.",
      },
    };
  }
  const days = expiringDays(c, now);
  if (days != null) {
    return {
      action: "reconnect",
      actionLabel: "Reconectar",
      notice: {
        tone: "warning",
        text:
          days <= 0
            ? "Acesso expira hoje. Reconecte para manter."
            : `Acesso expira em ${days} ${days === 1 ? "dia" : "dias"}. Reconecte para manter.`,
      },
    };
  }
  return { action: null, actionLabel: null, notice: null };
}

export interface GroupableMetaConfig {
  _id: string;
  channel: string;
  displayName: string;
  metaConnectionId: string | null;
}

export interface MetaConfigGroup<T extends GroupableMetaConfig> {
  key: string;
  title: string;
  configs: T[];
}

const CHANNEL_ORDER: Record<string, number> = { messenger: 0, instagram: 1 };
const CHANNEL_NAME: Record<string, string> = { messenger: "Messenger", instagram: "Instagram" };

/**
 * Agrupa os canais da mesma conexão (Página). Título: "Página X: Messenger +
 * Instagram". O nome da Página vem do config Messenger (o do Instagram é o @).
 */
export function groupMetaConfigs<T extends GroupableMetaConfig>(configs: T[]): MetaConfigGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const c of configs) {
    const key = c.metaConnectionId ?? `solo:${c._id}`;
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const sorted = [...list].sort(
      (a, b) => (CHANNEL_ORDER[a.channel] ?? 9) - (CHANNEL_ORDER[b.channel] ?? 9)
    );
    const pageName = (sorted.find((c) => c.channel === "messenger") ?? sorted[0]).displayName;
    const names = sorted.map((c) => CHANNEL_NAME[c.channel] ?? c.channel).join(" + ");
    return { key, title: `${pageName}: ${names}`, configs: sorted };
  });
}

/** Marca no sessionStorage que o login da Meta em curso é um Reconectar. */
export const RECONNECT_FLAG_KEY = "hnbcrm:meta-reconnecting";
