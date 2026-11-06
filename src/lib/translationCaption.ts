/**
 * Rodapé compacto (1 linha) da tradução na bolha, estilo WhatsApp:
 * "Traduzido do espanhol · Ver original", "Enviado em inglês · Ver o que você
 * escreveu". Os estados e quem decide o que aparece continuam em
 * `translationRules.ts` (`translationView`/`bubbleTranslation`); aqui só o texto.
 */
import { languageDisplayName, type TranslationView } from "./translationRules";

type Translated = Extract<TranslationView, { kind: "translated" }>;

export interface TranslationCaption {
  /** O que está à vista. */
  label: string;
  /** Ação do toque (null = sem alternar, com "mostrar original junto"). */
  action: string | null;
}

const lower = (code?: string) => languageDisplayName(code, { lower: true });

/** `showingSecondary`: o usuário tocou e está vendo o texto secundário. */
export function translationCaption(
  view: Translated,
  { showingSecondary, showBoth }: { showingSecondary: boolean; showBoth: boolean }
): TranslationCaption {
  const secondary = showingSecondary && !showBoth;
  if (view.role === "inbound") {
    const lang = lower(view.secondaryLang);
    return secondary
      ? { label: lang ? `Original em ${lang}` : "Original", action: "Ver tradução" }
      : { label: lang ? `Traduzido do ${lang}` : "Traduzido", action: showBoth ? null : "Ver original" };
  }
  if (view.role === "outbound") {
    const lang = lower(view.primaryLang);
    const edited = view.label.includes("editada");
    return secondary
      ? { label: "Você escreveu", action: "Ver o que foi enviado" }
      : {
          label: `${lang ? `Enviado em ${lang}` : "Enviado traduzido"}${edited ? " · tradução editada" : ""}`,
          action: showBoth ? null : "Ver o que você escreveu",
        };
  }
  // display: resposta da IA, enviada no idioma do lead.
  const lang = lower(view.primaryLang);
  return secondary
    ? { label: view.secondaryLabel, action: view.showPrimaryLabel }
    : { label: lang ? `Resposta da IA em ${lang}` : view.label, action: showBoth ? null : view.showSecondaryLabel };
}
