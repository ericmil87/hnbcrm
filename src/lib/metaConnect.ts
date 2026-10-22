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
 */
export function metaReturnMessage(code: string): MetaReturnMessage | null {
  if (code === "selecionar") return null;
  return MESSAGES[code] ?? FALLBACK;
}

export type MetaAuthState = "ok" | "reauth_required" | "revoked";

export interface MetaConnectionStateInput {
  metaAuthState: MetaAuthState | null;
  metaSubscribed: boolean | null;
  disabledByModuleAt: number | null;
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
