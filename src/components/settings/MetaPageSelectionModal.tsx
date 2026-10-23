import { useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Spinner } from "@/components/ui/Spinner";
import { mutationErrorMessage } from "@/lib/errors";
import { metaReturnMessage } from "@/lib/metaConnect";

interface MetaPageSelectionModalProps {
  organizationId: Id<"organizations">;
  pendingId: Id<"metaOAuthPending">;
  onClose: () => void;
}

type Pick = { messenger: boolean; instagram: boolean };

/** Escolha de Páginas quando o login da Meta devolve mais de uma (?meta=selecionar). */
export function MetaPageSelectionModal({ organizationId, pendingId, onClose }: MetaPageSelectionModalProps) {
  const selection = useQuery(api.metaMessaging.getPendingSelection, { organizationId, pendingId });
  const finalize = useAction(api.metaMessaging.finalizeMetaSelection);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [saving, setSaving] = useState(false);
  // Depois de finalizar, a pendência some do servidor: isso não significa "expirou".
  const finalizedRef = useRef(false);

  // Pendência expirada ou inexistente: avisa e fecha.
  useEffect(() => {
    if (selection === null && !finalizedRef.current) {
      const msg = metaReturnMessage("expirado");
      if (msg) toast.error(msg.text, { id: "meta-expirado" });
      onClose();
    }
  }, [selection, onClose]);

  if (selection === undefined || selection === null) {
    return (
      <Modal open onClose={onClose} title="Escolher Páginas">
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      </Modal>
    );
  }

  const pickFor = (pageId: string, hasIg: boolean, tasksOk: boolean): Pick =>
    picks[pageId] ?? { messenger: tasksOk, instagram: tasksOk && hasIg };

  const setPick = (pageId: string, hasIg: boolean, tasksOk: boolean, patch: Partial<Pick>) =>
    setPicks((prev) => ({ ...prev, [pageId]: { ...pickFor(pageId, hasIg, tasksOk), ...patch } }));

  const chosen = selection.pages
    .map((p) => ({ pageId: p.pageId, ...pickFor(p.pageId, !!p.igAccountId, p.tasksOk) }))
    .filter((p) => p.messenger || p.instagram);

  const handleConfirm = async () => {
    setSaving(true);
    try {
      finalizedRef.current = true;
      const result = await finalize({ organizationId, pendingId, picks: chosen });
      if (result.ok) {
        const ok = metaReturnMessage("ok");
        if (ok) toast.success(ok.text);
      } else {
        const msg = metaReturnMessage(result.code);
        if (msg) toast.error(msg.text);
      }
      onClose();
    } catch (error) {
      finalizedRef.current = false;
      toast.error(mutationErrorMessage(error, "Não foi possível conectar as Páginas"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Escolher Páginas">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          Sua conta tem mais de uma Página. Escolha o que conectar ao HNBCRM.
        </p>

        <ul className="space-y-3">
          {selection.pages.map((page) => {
            const hasIg = !!page.igAccountId;
            const pick = pickFor(page.pageId, hasIg, page.tasksOk);
            return (
              <li key={page.pageId} className="rounded-lg border border-border bg-surface-sunken p-3.5">
                <p className="font-medium text-text-primary">{page.pageName}</p>
                {!page.tasksOk && (
                  <p className="mt-1 text-xs text-semantic-warning">
                    Você precisa das tarefas de mensagens e moderação nesta Página.
                  </p>
                )}
                <div className="mt-2 space-y-1">
                  <Checkbox
                    id={`pick-messenger-${page.pageId}`}
                    label={`Messenger da Página ${page.pageName}`}
                    checked={pick.messenger}
                    disabled={!page.tasksOk || saving}
                    onChange={(e) => setPick(page.pageId, hasIg, page.tasksOk, { messenger: e.target.checked })}
                  />
                  {hasIg && (
                    <Checkbox
                      id={`pick-instagram-${page.pageId}`}
                      label={`Instagram @${page.igUsername ?? ""}`.trim()}
                      checked={pick.instagram}
                      disabled={!page.tasksOk || saving}
                      onChange={(e) => setPick(page.pageId, hasIg, page.tasksOk, { instagram: e.target.checked })}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="flex gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={saving} className="flex-1 min-h-[44px]">
            Cancelar
          </Button>
          <Button
            onClick={() => void handleConfirm()}
            disabled={saving || chosen.length === 0}
            className="flex-1 min-h-[44px]"
          >
            {saving && <Spinner size="sm" />}
            Conectar selecionadas
          </Button>
        </div>
      </div>
    </Modal>
  );
}
