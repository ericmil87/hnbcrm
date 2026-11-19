import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router";
import { useConvex, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { CheckCircle2, Lock, Smartphone, Undo2 } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { Spinner } from "@/components/ui/Spinner";
import { usePageTitle } from "@/hooks/usePageTitle";
import { usePermissions } from "@/hooks/usePermissions";
import { mutationErrorMessage } from "@/lib/errors";
import { formatCount } from "@/lib/format";
import { parseVcf } from "@/lib/vcard";
import {
  buildImportPayload,
  buildTriageRows,
  chunk,
  initialChoices,
  type TriageBuildResult,
  type TriageChoice,
} from "@/lib/phoneContactsTriage";
import { PhoneImportTriageView, type ExistingMatch } from "./PhoneImportTriageView";

/** Mesmo teto do servidor (`MAX_PHONE_IMPORT_ROWS`). */
const MAX_ROWS = 5000;
/** Mesmo teto do servidor (`MATCH_CHUNK_ROWS`). */
const MATCH_CHUNK = 100;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const ROUTE_CONTACTS = "/app/contatos";

/**
 * "Importar contatos do celular" (PR6, recurso avançado, fora do onboarding).
 * O .vcf é lido aqui no navegador; só as linhas escolhidas vão ao servidor.
 */
export function PhoneContactsImportPage() {
  usePageTitle("Importar contatos do celular");
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { can, isLoading } = usePermissions(organizationId);
  const convex = useConvex();
  const context = useQuery(api.phoneContactsImport.getPhoneImportContext, { organizationId });
  const startImport = useMutation(api.phoneContactsImport.startPhoneContactsImport);

  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [triage, setTriage] = useState<TriageBuildResult | null>(null);
  const [choices, setChoices] = useState<Record<string, TriageChoice | undefined>>({});
  const [existing, setExisting] = useState<Map<string, ExistingMatch>>(() => new Map());
  const [matching, setMatching] = useState<{ done: number; total: number } | null>(null);
  const [createLeads, setCreateLeads] = useState(false);
  const [useAgendaNames, setUseAgendaNames] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<Id<"importJobs"> | null>(null);
  // Cancela a consulta "já está no CRM" de um arquivo anterior.
  const runRef = useRef(0);

  const restart = useCallback(() => {
    runRef.current += 1;
    setFile(null);
    setTriage(null);
    setChoices({});
    setExisting(new Map());
    setMatching(null);
    setJobId(null);
  }, []);

  useEffect(() => () => void (runRef.current += 1), []);

  const handleFile = async (next: File | null) => {
    setFile(next);
    if (!next || !context) return;
    if (next.size > MAX_FILE_BYTES) return; // o FileDropZone já mostra o aviso
    setReading(true);
    const run = ++runRef.current;
    try {
      const text = await next.text();
      const result = buildTriageRows(parseVcf(text), context.defaultCountry, context.surnames);
      if (run !== runRef.current) return;
      if (result.rows.length === 0) {
        toast.error(
          result.total === 0
            ? "Não encontramos contatos neste arquivo. Ele precisa ser um .vcf (vCard)."
            : "Nenhum contato do arquivo tem telefone ou e-mail."
        );
        setFile(null);
        return;
      }
      setTriage(result);
      setChoices(initialChoices(result.rows));
      setExisting(new Map());
      // Quem já está no CRM, em pedaços (só telefones/e-mails normalizados; nada é gravado).
      const pieces = chunk(result.rows, MATCH_CHUNK);
      setMatching({ done: 0, total: result.rows.length });
      let done = 0;
      for (const piece of pieces) {
        const matches = await convex.query(api.phoneContactsImport.matchPhoneContacts, {
          organizationId,
          rows: piece.map((row) => ({ key: row.key, phones: row.phones, emails: row.emails })),
        });
        if (run !== runRef.current) return;
        done += piece.length;
        setExisting((current) => {
          const next = new Map(current);
          for (const m of matches) next.set(m.key, { contactId: m.contactId, name: m.name, relation: m.relation });
          return next;
        });
        setMatching({ done, total: result.rows.length });
      }
      setMatching(null);
    } catch (error) {
      if (run !== runRef.current) return;
      setMatching(null);
      toast.error(mutationErrorMessage(error, "Não foi possível ler o arquivo."));
    } finally {
      if (run === runRef.current) setReading(false);
    }
  };

  const handleChoose = (keys: string[], choice: TriageChoice) =>
    setChoices((current) => {
      const next = { ...current };
      for (const key of keys) next[key] = choice;
      return next;
    });

  const handleSubmit = async () => {
    if (!triage) return;
    const rows = buildImportPayload(triage.rows, choices);
    if (rows.length === 0) return;
    setSubmitting(true);
    try {
      const id = await startImport({
        organizationId,
        fileName: file?.name ?? "contatos.vcf",
        createLeads,
        useAgendaNames,
        rows,
      });
      setJobId(id);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível importar os contatos."));
    } finally {
      setSubmitting(false);
    }
  };

  const header = (
    <PageHeader
      title="Importar contatos do celular"
      subtitle="Traga a agenda do seu celular e diga quem é lead e quem não é"
      back={{ to: ROUTE_CONTACTS }}
    />
  );

  if (isLoading || context === undefined) {
    return (
      <div className="max-w-4xl">
        {header}
        <div className="flex justify-center py-12">
          <Spinner size="lg" />
        </div>
      </div>
    );
  }

  if (!can("contacts", "edit") || context === null) {
    return (
      <div className="max-w-4xl">
        {header}
        <EmptyState
          icon={Lock}
          title="Sem permissão para importar"
          description="Peça a um administrador a permissão de editar contatos."
          action={{ label: "Voltar para Contatos", href: ROUTE_CONTACTS }}
        />
      </div>
    );
  }

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      {header}
      {jobId ? (
        <PhoneImportResult organizationId={organizationId} jobId={jobId} onRestart={restart} />
      ) : triage ? (
        <>
          <p className="text-sm text-text-secondary tabular-nums">
            {formatCount(triage.total)} contato(s) no arquivo · {formatCount(triage.rows.length)} com telefone ou e-mail
            {triage.merged > 0 && ` · ${formatCount(triage.merged)} repetido(s) juntado(s)`}
            {triage.withoutContact > 0 && ` · ${formatCount(triage.withoutContact)} sem telefone nem e-mail ficaram de fora`}
          </p>
          <PhoneImportTriageView
            rows={triage.rows}
            choices={choices}
            onChoose={handleChoose}
            existing={existing}
            matching={matching}
            createLeads={createLeads}
            onCreateLeadsChange={setCreateLeads}
            useAgendaNames={useAgendaNames}
            onUseAgendaNamesChange={setUseAgendaNames}
            maxRows={MAX_ROWS}
            submitting={submitting}
            onSubmit={handleSubmit}
            onRestart={restart}
          />
        </>
      ) : (
        <PhoneImportStart file={file} reading={reading} onFile={handleFile} />
      )}
    </div>
  );
}

interface PhoneImportStartProps {
  file: File | null;
  reading: boolean;
  onFile: (file: File | null) => void;
}

/** Passo 1: como exportar o .vcf + envio do arquivo. */
function PhoneImportStart({ file, reading, onFile }: PhoneImportStartProps) {
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-card border border-border bg-surface-raised p-4" aria-labelledby="vcf-help">
        <h2 id="vcf-help" className="flex items-center gap-2 text-base font-semibold text-text-primary">
          <Smartphone size={18} aria-hidden="true" className="text-brand-500" />
          Como tirar os contatos do celular
        </h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Android (Google Contatos)</h3>
            <p className="mt-1 text-sm text-text-secondary">
              Abra o app Contatos › Corrigir e gerenciar › Exportar para arquivo. Ou, no computador, entre em
              contacts.google.com › Exportar › vCard. Sai um arquivo .vcf.
            </p>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">iPhone</h3>
            <p className="mt-1 text-sm text-text-secondary">
              No app Contatos, toque em Listas, segure "Todos os contatos" › Exportar (iOS 16 ou mais novo). Ou, no
              computador, entre em icloud.com/contacts, selecione todos › Exportar vCard.
            </p>
          </div>
        </div>
        <p className="mt-3 flex items-start gap-2 text-caption text-text-muted">
          <Lock size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          O arquivo é lido aqui no seu aparelho. Só os contatos que você escolher vão para o CRM, e nenhuma mensagem é
          enviada.
        </p>
      </section>
      <FileDropZone
        file={file}
        onFileChange={onFile}
        accept=".vcf,.vcard"
        maxSizeBytes={MAX_FILE_BYTES}
        disabled={reading}
        hint="Arquivo .vcf com um ou vários contatos"
      />
      {reading && (
        <p className="flex items-center gap-2 text-sm text-text-secondary" role="status">
          <Spinner size="sm" /> Lendo os contatos…
        </p>
      )}
    </div>
  );
}

interface PhoneImportResultProps {
  organizationId: Id<"organizations">;
  jobId: Id<"importJobs">;
  onRestart: () => void;
}

/** Passo 3: progresso, resultado e "Desfazer importação". */
function PhoneImportResult({ organizationId, jobId, onRestart }: PhoneImportResultProps) {
  const job = useQuery(api.phoneContactsImport.getPhoneContactsImport, { organizationId, jobId });
  const undo = useMutation(api.phoneContactsImport.undoPhoneContactsImport);
  const [confirmUndo, setConfirmUndo] = useState(false);

  if (job === undefined) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }
  if (job === null) {
    return <p className="text-sm text-text-secondary">Importação não encontrada.</p>;
  }

  const p = job.progress;
  const running = job.status === "running";
  const done = job.status === "completed" || job.status === "completed_with_errors";
  const percent = p.total > 0 ? Math.min(100, Math.round((p.processed / p.total) * 100)) : 0;

  const handleUndo = () => {
    toast.promise(undo({ organizationId, jobId }), {
      loading: "Desfazendo a importação…",
      success: "Importação desfeita",
      error: (error) => mutationErrorMessage(error, "Não foi possível desfazer a importação."),
    });
  };

  return (
    <section className="flex flex-col gap-4 rounded-card border border-border bg-surface-raised p-4" aria-live="polite">
      {running && (
        <>
          <p className="text-sm font-medium text-text-primary">Importando {job.fileName}…</p>
          <div
            className="h-2 overflow-hidden rounded-full bg-surface-sunken"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label="Progresso da importação"
          >
            <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-caption text-text-muted tabular-nums">
            {formatCount(p.processed)} de {formatCount(p.total)} contatos
          </p>
        </>
      )}
      {done && (
        <>
          <p className="flex items-center gap-2 text-base font-semibold text-text-primary">
            <CheckCircle2 size={20} aria-hidden="true" className="text-semantic-success" />
            Importação concluída
          </p>
          <p className="text-sm text-text-secondary tabular-nums">
            {formatCount(p.created)} novo(s) · {formatCount(p.updated)} atualizado(s) · {formatCount(p.skipped)} sem
            mudança
            {p.failed > 0 && <span className="text-semantic-error"> · {formatCount(p.failed)} com erro</span>}
          </p>
          <p className="text-caption text-text-muted">
            Eles têm a etiqueta "importado-celular". Quem não é cliente ficou fora do funil e a IA não responde a eles.
          </p>
        </>
      )}
      {job.status === "rolled_back" && (
        <p className="text-sm text-text-secondary">Importação desfeita. Os contatos novos foram apagados e os que já existiam voltaram ao que eram.</p>
      )}
      {job.status === "failed" && (
        <p className="text-sm text-semantic-error" role="alert">
          A importação falhou{job.error ? `: ${job.error}` : "."}
        </p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Link
          to={ROUTE_CONTACTS}
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-brand-600 px-5 text-sm font-medium text-white hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
        >
          Ver contatos
        </Link>
        {done && (
          <Button variant="secondary" size="lg" onClick={() => setConfirmUndo(true)}>
            <Undo2 size={18} aria-hidden="true" />
            Desfazer importação
          </Button>
        )}
        {!running && (
          <Button variant="ghost" size="lg" onClick={onRestart}>
            Importar outro arquivo
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmUndo}
        onClose={() => setConfirmUndo(false)}
        onConfirm={handleUndo}
        title="Desfazer a importação?"
        description="Os contatos criados agora serão apagados e os que já existiam voltam ao tipo, nome e etiquetas de antes."
        confirmLabel="Desfazer"
        variant="danger"
      />
    </section>
  );
}
