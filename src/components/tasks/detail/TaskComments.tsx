import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Send, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import { detectMentionTrigger } from "@/lib/mentions";
import { assignableMembers, memberLabel } from "@/lib/teamMembers";

interface MentionCandidate {
  _id: Id<"teamMembers">;
  name: string;
  type: "human" | "ai";
  avatarUrl?: string | null;
}

interface TaskCommentsProps {
  taskId: Id<"tasks">;
  organizationId: Id<"organizations">;
}

/**
 * Comentários da tarefa com menção por "@". O texto guarda "@Nome " e os ids
 * dos mencionados vão em `mentionedUserIds` (formato próprio das tarefas; o
 * `MentionTextarea` das notas internas grava tokens `@[Nome](id)`, outro
 * formato, por isso não é reaproveitado aqui). O painel monta este bloco com
 * `key` da tarefa: o rascunho e as menções pendentes não vazam entre tarefas.
 */
export function TaskComments({ taskId, organizationId }: TaskCommentsProps) {
  const comments = useQuery(api.taskComments.getComments, { taskId });
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });
  const addComment = useMutation(api.taskComments.addComment);

  const [commentText, setCommentText] = useState("");
  const [sending, setSending] = useState(false);
  const [mentionedMembers, setMentionedMembers] = useState<MentionCandidate[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStartIndex, setMentionStartIndex] = useState<number | null>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const memberMap = useMemo(() => {
    const map = new Map<string, string>();
    teamMembers?.forEach((m) => map.set(m._id, memberLabel(m)));
    return map;
  }, [teamMembers]);

  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.trim().toLowerCase();
    // Mencionar quem saiu da org não notifica ninguém: fora das sugestões.
    return assignableMembers(teamMembers)
      .filter((m) => m.name.toLowerCase().includes(q))
      .slice(0, 6)
      .map((m) => ({ _id: m._id, name: m.name, type: m.type, avatarUrl: m.avatarUrl }));
  }, [teamMembers, mentionQuery]);

  const closeMentionList = () => {
    setMentionQuery(null);
    setMentionStartIndex(null);
  };

  const handleSend = async () => {
    if (!commentText.trim() || sending) return;
    setSending(true);
    try {
      await addComment({
        taskId,
        content: commentText.trim(),
        mentionedUserIds: mentionedMembers.length > 0 ? mentionedMembers.map((m) => m._id) : undefined,
      });
      setCommentText("");
      setMentionedMembers([]);
      closeMentionList();
    } catch {
      toast.error("Não foi possível adicionar o comentário.");
    } finally {
      setSending(false);
    }
  };

  // Atualiza o texto e detecta se o caret está numa menção "@algo" em digitação.
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setCommentText(value);
    const trigger = detectMentionTrigger(value, e.target.selectionStart ?? value.length);
    if (trigger) {
      setMentionStartIndex(trigger.start);
      setMentionQuery(trigger.query);
      setMentionActiveIndex(0);
    } else {
      closeMentionList();
    }
  };

  // Insere "@Nome " no lugar da menção em digitação e registra o membro.
  const selectMention = (member: MentionCandidate) => {
    if (mentionStartIndex === null) return;
    const textarea = inputRef.current;
    const caret = textarea?.selectionStart ?? commentText.length;
    const before = commentText.slice(0, mentionStartIndex);
    const after = commentText.slice(caret);
    const insertion = `@${member.name} `;

    setCommentText(before + insertion + after);
    setMentionedMembers((prev) => (prev.some((m) => m._id === member._id) ? prev : [...prev, member]));
    closeMentionList();

    requestAnimationFrame(() => {
      const pos = before.length + insertion.length;
      textarea?.focus();
      textarea?.setSelectionRange(pos, pos);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && mentionCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionActiveIndex((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionActiveIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectMention(mentionCandidates[mentionActiveIndex]);
        return;
      }
      if (e.key === "Escape") {
        // Fecha só a lista de menção: não deve fechar o painel.
        e.preventDefault();
        e.stopPropagation();
        closeMentionList();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="px-4 py-4">
      <h4 className="text-sm font-semibold text-text-primary mb-3">Comentários</h4>

      {comments === undefined ? (
        <div className="flex justify-center py-4">
          <Spinner size="sm" />
        </div>
      ) : comments.length === 0 ? (
        <p className="text-sm text-text-muted mb-3">Nenhum comentário ainda.</p>
      ) : (
        <ul className="space-y-3 mb-3">
          {comments.map((comment) => {
            const authorName = memberMap.get(comment.authorId);
            return (
              <li key={comment._id} className="flex gap-2">
                <Avatar name={authorName || "?"} type={comment.authorType} size="sm" className="shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-text-primary">{authorName || "Desconhecido"}</span>
                    <span className="text-xs text-text-muted tabular-nums">{formatDateTime(comment.createdAt)}</span>
                  </div>
                  <p className="text-sm text-text-secondary whitespace-pre-wrap break-words">{comment.content}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {mentionedMembers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {mentionedMembers.map((m) => (
            <span
              key={m._id}
              className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium bg-brand-500/10 text-brand-400"
            >
              @{m.name}
              <button
                type="button"
                onClick={() => setMentionedMembers((prev) => prev.filter((x) => x._id !== m._id))}
                aria-label={`Remover menção a ${m.name}`}
                className="flex min-h-6 min-w-6 coarse:min-h-11 coarse:min-w-11 items-center justify-center rounded-full hover:bg-surface-overlay transition-colors"
              >
                <X size={10} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <div className="relative flex-1">
          <textarea
            ref={inputRef}
            value={commentText}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            aria-label="Novo comentário"
            placeholder="Adicionar comentário… (use @ para mencionar)"
            rows={2}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none placeholder:text-text-muted"
          />

          {mentionQuery !== null && (
            <div className="absolute left-0 right-0 bottom-full z-20 mb-1 bg-surface-overlay border border-border rounded-xl shadow-elevated p-1 max-h-48 overflow-y-auto">
              {mentionCandidates.length === 0 ? (
                <p className="px-3 py-2 text-xs text-text-muted">Nenhum membro encontrado.</p>
              ) : (
                mentionCandidates.map((m, i) => (
                  <button
                    key={m._id}
                    type="button"
                    onMouseDown={(e) => {
                      // preventDefault evita que o textarea perca o foco antes do clique.
                      e.preventDefault();
                      selectMention(m);
                    }}
                    className={cn(
                      "w-full flex min-h-11 items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors",
                      i === mentionActiveIndex ? "bg-surface-raised" : "hover:bg-surface-raised"
                    )}
                  >
                    <Avatar name={m.name} type={m.type} size="sm" imageUrl={m.avatarUrl ?? null} />
                    <span className="text-sm text-text-primary truncate">{m.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          iconOnly
          onClick={() => void handleSend()}
          disabled={sending || !commentText.trim()}
          className="self-end"
          aria-label="Enviar comentário"
        >
          <Send size={14} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
