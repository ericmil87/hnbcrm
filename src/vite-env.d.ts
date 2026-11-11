/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Link do grupo da comunidade (WhatsApp). Sem ele, a seção Comunidade da landing não aparece. */
  readonly VITE_COMMUNITY_URL?: string;
}
