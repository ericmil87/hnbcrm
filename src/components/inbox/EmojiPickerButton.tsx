import { useEffect, useRef, useState } from "react";
import { Smile } from "lucide-react";
import { cn } from "@/lib/utils";

// Emoji aqui é conteúdo do usuário (vai no texto da mensagem), não ícone de UI —
// mesma exceção do ReactionPicker; a UI em si continua com lucide.
const CATEGORIES: Array<{ label: string; emojis: string[] }> = [
  {
    label: "Sorrisos",
    emojis: [
      "😀", "😁", "😂", "🤣", "😅", "😊", "😇", "🙂", "😉", "😍",
      "🥰", "😘", "😋", "😜", "🤪", "🤔", "🤨", "😐", "😏", "🙄",
      "😬", "😴", "😷", "🤯", "😎", "🥳", "😢", "😭", "😤", "😡",
      "😱", "🥺", "😳", "🤗", "🤭", "🤫",
    ],
  },
  {
    label: "Gestos",
    emojis: [
      "👍", "👎", "👌", "✌️", "🤞", "🤙", "👋", "👏", "🙌", "🤝",
      "🙏", "💪", "🫶", "👊", "☝️", "👆", "👇", "👉", "👈", "✍️",
    ],
  },
  {
    label: "Corações",
    emojis: [
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "💕",
      "💖", "💘", "❤️‍🔥", "💯",
    ],
  },
  {
    label: "Símbolos e objetos",
    emojis: [
      "🔥", "⭐", "✨", "🎉", "🎊", "🎁", "🏆", "🚀", "📞", "📱",
      "💻", "📅", "📌", "📎", "💰", "✅", "❌", "⚠️", "❓", "❗",
      "⏰", "📍", "☕", "🍻",
    ],
  },
];

const RECENTS_KEY = "hnb-emoji-recents";
const RECENTS_MAX = 16;

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(emoji: string): string[] {
  const next = [emoji, ...loadRecents().filter((e) => e !== emoji)].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // localStorage indisponível (ex.: modo privado) — recentes viram só da sessão
  }
  return next;
}

interface EmojiPickerButtonProps {
  /** Insere o emoji no composer (o chamador decide a posição do cursor). */
  onPick: (emoji: string) => void;
  disabled?: boolean;
}

export function EmojiPickerButton({ onPick, disabled }: EmojiPickerButtonProps) {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const handlePick = (emoji: string) => {
    setRecents(saveRecent(emoji));
    onPick(emoji);
  };

  const sections: Array<{ label: string; emojis: string[] }> = recents.length
    ? [{ label: "Recentes", emojis: recents }, ...CATEGORIES]
    : CATEGORIES;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={cn(
          "p-2 rounded-full text-text-muted hover:text-brand-500 hover:bg-brand-500/10 transition-colors",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          open && "text-brand-500 bg-brand-500/10"
        )}
        aria-label="Inserir emoji"
        aria-expanded={open}
        title="Inserir emoji"
      >
        <Smile size={18} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Escolher emoji"
          className={cn(
            "absolute bottom-full left-0 mb-2 z-30 w-72 max-h-72 overflow-y-auto p-2",
            "bg-surface-overlay border border-border rounded-xl shadow-elevated animate-fade-in-up"
          )}
        >
          {sections.map((section) => (
            <div key={section.label} className="mb-1.5 last:mb-0">
              <p className="px-1 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                {section.label}
              </p>
              <div className="grid grid-cols-8">
                {section.emojis.map((emoji) => (
                  <button
                    key={`${section.label}-${emoji}`}
                    type="button"
                    role="menuitem"
                    onClick={() => handlePick(emoji)}
                    className="flex items-center justify-center h-8 w-8 rounded-lg text-lg leading-none hover:bg-surface-raised hover:scale-110 transition-transform focus:outline-none focus:ring-2 focus:ring-brand-500"
                    aria-label={`Inserir ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
