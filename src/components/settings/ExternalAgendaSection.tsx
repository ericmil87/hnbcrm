import { useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { toast } from "sonner";
import { CalendarDays } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";

/**
 * Agenda externa do atendente (v0.64): endpoint da org que é a fonte de
 * verdade de datas, valores e vagas. Ligada, o atendente ganha a consulta
 * `consultarAgenda` e pode mandar o flyer do evento. A chave é write-only —
 * a tela só mostra os 4 últimos caracteres.
 */
export function ExternalAgendaSection({
  organizationId,
  agentMemberId,
}: {
  organizationId: Id<"organizations">;
  agentMemberId: Id<"teamMembers">;
}) {
  const config = useQuery(api.aiSettings.getExternalAgendaConfig, { agentMemberId });
  const save = useAction(api.aiSettings.setExternalAgenda);

  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [headerName, setHeaderName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (config === undefined || loaded) return;
    setEnabled(config?.enabled ?? false);
    setUrl(config?.url ?? "");
    setHeaderName(config && config.headerName !== "X-API-Key" ? config.headerName : "");
    setLoaded(true);
  }, [config, loaded]);

  const handleSave = async () => {
    if (!url.trim()) {
      toast.error("Informe a URL da agenda");
      return;
    }
    setBusy(true);
    try {
      await save({
        organizationId,
        agentMemberId,
        enabled,
        url: url.trim(),
        headerName: headerName.trim() || undefined,
        apiKey: apiKey.trim() ? apiKey.trim() : null,
      });
      setApiKey("");
      toast.success("Agenda externa salva");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao salvar a agenda externa");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 pt-4 border-t border-border">
      <div className="flex items-start gap-2">
        <CalendarDays size={16} className="shrink-0 text-text-muted mt-0.5" />
        <div>
          <p className="text-sm font-medium text-text-primary">Agenda externa</p>
          <p className="text-xs text-text-muted mt-0.5">
            Endpoint (https) que devolve as próximas datas, valores e vagas. Ligada, a IA consulta
            antes de falar de qualquer evento e pode enviar o flyer — nunca cita data de memória.
          </p>
        </div>
      </div>
      <Checkbox
        checked={enabled}
        onChange={() => setEnabled((v) => !v)}
        label={<span className="text-sm text-text-secondary">Consultar a agenda externa</span>}
      />
      <div className="grid gap-3 sm:grid-cols-2 max-w-2xl">
        <div className="sm:col-span-2">
          <Input
            label="URL da agenda"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://seusite.com/api/agenda"
          />
        </div>
        <Input
          label="Nome do header (opcional)"
          type="text"
          value={headerName}
          onChange={(e) => setHeaderName(e.target.value)}
          placeholder="X-API-Key"
        />
        <div>
          <Input
            label="Chave de API"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.hasKey ? "Deixe em branco para manter" : "Opcional"}
          />
          {config?.hasKey && (
            <p className="text-xs text-text-muted mt-1.5">Chave salva ••••{config.keyLast4}</p>
          )}
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={() => void handleSave()} disabled={busy}>
        {busy ? "Salvando…" : "Salvar agenda"}
      </Button>
    </section>
  );
}
