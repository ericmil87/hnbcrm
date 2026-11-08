import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { BellOff, Lock, Moon, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Tooltip } from "@/components/ui/Tooltip";
import { mutationErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  PAUSE_OPTIONS,
  PRESET_OPTIONS,
  buildMatrixGroups,
  isPaused,
  pausedUntilLabel,
  validateQuietHours,
  type MatrixChannel,
} from "@/lib/notificationPrefsUi";
import { NOTIFICATION_GROUP_LABELS } from "../../../convex/lib/notificationGroups";

export type Preset = "all" | "mine" | "none";
export type PauseMode = "1h" | "4h" | "tomorrow";

export interface EffectivePrefs {
  preset: Preset;
  presetSource: "member" | "org" | "default";
  channels: {
    bell: Record<string, boolean>;
    email: Record<string, boolean>;
    telegram: Record<string, boolean>;
    push: Record<string, boolean>;
  };
  actionableFlags: string[];
  pausedUntil: number | null;
  quietHours: { enabled: boolean; start: string; end: string; timeZone: string };
  urgentBypass: boolean;
  showPreview: boolean;
  orgHidePreview: boolean;
  effectiveShowPreview: boolean;
  orgDefaults: { preset: Preset | null; hidePreviewOnLockScreen: boolean };
}

export interface QuietHoursInput {
  enabled: boolean;
  start: string;
  end: string;
  timeZone?: string;
}

export interface NotificationPreferencesViewProps {
  prefs: EffectivePrefs;
  now: number;
  /** `settings:manage`: mostra os padrões da organização. */
  canManageOrg: boolean;
  /** Membro com Telegram vinculado (a coluna Telegram só existe então). */
  telegramLinked: boolean;
  /** Aparelho com suporte e recurso ligado. */
  pushAvailable: boolean;
  deviceTimeZone?: string;
  onPreset: (preset: Preset) => Promise<unknown>;
  onChannel: (channel: MatrixChannel, flag: string, enabled: boolean) => Promise<unknown>;
  onPause: (mode: PauseMode) => Promise<unknown>;
  onResume: () => Promise<unknown>;
  onQuietHours: (input: QuietHoursInput) => Promise<unknown>;
  onUrgentBypass: (value: boolean) => Promise<unknown>;
  onShowPreview: (value: boolean) => Promise<unknown>;
  onApplyAll: () => Promise<{ applied: number; skipped: number }>;
  onOrgDefaults: (input: { preset: Preset; hidePreviewOnLockScreen: boolean }) => Promise<unknown>;
}

const SAVED_TOAST_ID = "notification-pref-saved";
const CHANNEL_LABEL: Record<MatrixChannel, string> = { email: "E-mail", telegram: "Telegram", push: "Push" };

/** Toast único: cliques rápidos trocam o mesmo toast em vez de empilhar. */
function savedToast() {
  toast.success("Preferência salva", { id: SAVED_TOAST_ID });
}

function failToast(e: unknown) {
  toast.error(mutationErrorMessage(e, "Não foi possível salvar a preferência."));
}

export function NotificationPreferencesView(props: NotificationPreferencesViewProps) {
  const { prefs, now, canManageOrg } = props;
  const paused = isPaused(prefs.pausedUntil, now);

  return (
    <div className="space-y-6">
      <Card>
        <PauseBlock {...props} paused={paused} />
      </Card>
      <Card>
        <PresetBlock {...props} />
      </Card>
      <Card>
        <MatrixBlock {...props} />
      </Card>
      <Card>
        <DeliveryBlock {...props} />
      </Card>
      {canManageOrg && (
        <Card>
          <OrgDefaultsBlock {...props} />
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ pausa */

function PauseBlock({
  prefs,
  now,
  paused,
  onPause,
  onResume,
}: NotificationPreferencesViewProps & { paused: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      savedToast();
    } catch (e) {
      failToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <BellOff size={20} className="text-brand-500" aria-hidden="true" />
        <h3 className="text-lg font-semibold text-text-primary">Pausar avisos</h3>
      </div>
      <p className="text-sm text-text-secondary mb-4">
        Enquanto estiver pausado, e-mail, Telegram e push ficam em espera. O sino continua registrando tudo.
      </p>
      {paused && prefs.pausedUntil !== null ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p role="status" className="text-sm font-medium text-text-primary">
            {pausedUntilLabel(prefs.pausedUntil, now)}
          </p>
          <Button variant="secondary" onClick={() => void run(onResume)} disabled={busy}>
            Retomar
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {PAUSE_OPTIONS.map((o) => (
            <Button key={o.mode} variant="secondary" disabled={busy} onClick={() => void run(() => onPause(o.mode))}>
              {o.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- atalhos */

function PresetBlock({ prefs, onPreset, onApplyAll }: NotificationPreferencesViewProps) {
  const [optimistic, setOptimistic] = useState<Preset | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const selected = optimistic ?? prefs.preset;

  useEffect(() => {
    if (optimistic !== null && optimistic === prefs.preset) setOptimistic(null);
  }, [optimistic, prefs.preset]);

  const choose = async (preset: Preset) => {
    if (preset === selected) return;
    setOptimistic(preset);
    try {
      await onPreset(preset);
      savedToast();
    } catch (e) {
      setOptimistic(null);
      failToast(e);
    }
  };

  const applyAll = async () => {
    setApplying(true);
    try {
      const { applied, skipped } = await onApplyAll();
      setConfirmOpen(false);
      toast.success(
        skipped > 0
          ? `Aplicado em ${applied} ${applied === 1 ? "organização" : "organizações"}; ${skipped} não ${skipped === 1 ? "pôde" : "puderam"} ser atualizada${skipped === 1 ? "" : "s"}`
          : `Aplicado em ${applied} ${applied === 1 ? "organização" : "organizações"}`,
      );
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível aplicar às outras organizações."));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div>
      <h3 className="text-lg font-semibold text-text-primary mb-1">O que você quer receber</h3>
      <p className="text-sm text-text-secondary mb-4">
        Escolha um atalho. Escolher de novo apaga os ajustes finos de "Personalizar". O sino sempre registra o que
        precisa de você.
        {prefs.presetSource === "org" && " Hoje vale o padrão da organização."}
      </p>
      <div role="radiogroup" aria-label="O que você quer receber" className="grid gap-2 md:grid-cols-3">
        {PRESET_OPTIONS.map((o) => {
          const on = selected === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => void choose(o.value)}
              className={cn(
                "min-h-11 rounded-card border p-3 text-left transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
                on ? "border-brand-500 bg-brand-500/10" : "border-border bg-surface-raised hover:bg-surface-overlay",
              )}
            >
              <span className="block text-sm font-medium text-text-primary">{o.label}</span>
              <span className="mt-0.5 block text-xs text-text-secondary">{o.hint}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(true)}>
          Aplicar a todas as minhas organizações
        </Button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => (applying ? undefined : setConfirmOpen(false))}
        onConfirm={() => void applyAll()}
        title="Aplicar a todas as organizações?"
        description="Copia estas preferências (atalho, matriz, silêncio, pedido urgente e prévia) para as outras organizações em que você participa. A pausa não é copiada."
        confirmLabel={applying ? "Aplicando…" : "Aplicar"}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ matriz */

function MatrixBlock({ prefs, telegramLinked, pushAvailable, onChannel }: NotificationPreferencesViewProps) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => buildMatrixGroups(), []);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  // Descarta o palpite local quando o servidor já concorda com ele.
  useEffect(() => {
    setOverrides((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(prev)) {
        const [channel, flag] = key.split(":") as [MatrixChannel, string];
        if (prefs.channels[channel]?.[flag] === value) changed = true;
        else next[key] = value;
      }
      return changed ? next : prev;
    });
  }, [prefs.channels]);

  const columns = useMemo<MatrixChannel[]>(() => {
    const cols: MatrixChannel[] = ["email"];
    if (telegramLinked) cols.push("telegram");
    if (pushAvailable) cols.push("push");
    return cols;
  }, [telegramLinked, pushAvailable]);

  const valueOf = (channel: MatrixChannel, flag: string) =>
    overrides[`${channel}:${flag}`] ?? prefs.channels[channel]?.[flag] ?? false;

  const toggle = async (channel: MatrixChannel, flag: string, enabled: boolean) => {
    const key = `${channel}:${flag}`;
    setOverrides((p) => ({ ...p, [key]: enabled }));
    try {
      await onChannel(channel, flag, enabled);
      savedToast();
    } catch (e) {
      setOverrides((p) => {
        const { [key]: _drop, ...rest } = p;
        return rest;
      });
      failToast(e);
    }
  };

  const colClass = cn(
    "md:grid",
    columns.length === 1 && "md:grid-cols-[minmax(0,1fr)_72px_72px]",
    columns.length === 2 && "md:grid-cols-[minmax(0,1fr)_72px_72px_72px]",
    columns.length === 3 && "md:grid-cols-[minmax(0,1fr)_72px_72px_72px_72px]",
  );

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-text-primary mb-1">Personalizar</h3>
          <p className="text-sm text-text-secondary">
            Escolha, tipo por tipo, onde cada aviso chega. Salva ao tocar.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          aria-expanded={open}
          aria-controls="notification-matrix"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Ocultar" : "Personalizar"}
        </Button>
      </div>

      {open && (
        <div id="notification-matrix" className="mt-4 space-y-6">
          {!telegramLinked && (
            <p className="text-xs text-text-muted">
              Conecte o Telegram no cartão acima para receber avisos por lá; a coluna aparece quando houver vínculo.
            </p>
          )}
          <div className={cn("hidden gap-2 border-b border-border pb-2 text-xs font-medium text-text-muted", colClass)}>
            <span>Aviso</span>
            <span className="text-center">Sino</span>
            {columns.map((c) => (
              <span key={c} className="text-center">
                {CHANNEL_LABEL[c]}
              </span>
            ))}
          </div>
          {groups.map(({ group, rows }) => (
            <section key={group} aria-labelledby={`matrix-${group}`}>
              <h4
                id={`matrix-${group}`}
                className="mb-1 text-xs font-medium uppercase tracking-wider text-text-muted"
              >
                {NOTIFICATION_GROUP_LABELS[group]}
              </h4>
              <ul className="divide-y divide-border">
                {rows.map((row) => {
                  const actionable = prefs.actionableFlags.includes(row.flag);
                  const bellOn = actionable || (prefs.channels.bell[row.flag] ?? true);
                  return (
                    <li key={row.flag} className={cn("grid grid-cols-1 gap-2 py-3 md:items-center", colClass)}>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text-primary">{row.label}</p>
                        <p className="text-xs text-text-secondary">{row.desc}</p>
                      </div>
                      <div className="flex items-center justify-between gap-2 md:justify-center">
                        <span className="text-xs text-text-muted md:hidden">Sino</span>
                        {actionable ? (
                          <span
                            className="inline-flex min-h-11 items-center gap-1 text-xs text-text-secondary"
                            aria-label={`${row.label}: sino sempre ligado, porque precisa de uma ação sua`}
                          >
                            <Lock size={14} aria-hidden="true" />
                            Sempre
                          </span>
                        ) : (
                          <span className="inline-flex min-h-11 items-center text-xs text-text-secondary">
                            {bellOn ? "Ligado" : "Desligado"}
                          </span>
                        )}
                      </div>
                      {columns.map((c) => (
                        <div key={c} className="flex items-center justify-between gap-2 md:justify-center">
                          <span className="text-xs text-text-muted md:hidden">{CHANNEL_LABEL[c]}</span>
                          {row.channels.includes(c) ? (
                            <Switch
                              checked={valueOf(c, row.flag)}
                              onCheckedChange={(v) => void toggle(c, row.flag, v)}
                              label={`${row.label}: ${CHANNEL_LABEL[c]}`}
                              hideLabel
                              size="sm"
                            />
                          ) : (
                            <Tooltip content={c === "email" ? "Sem e-mail para este aviso" : `Sem ${CHANNEL_LABEL[c]} para este aviso`} asInfo>
                              <button
                                type="button"
                                aria-label={`${row.label}: ${c === "email" ? "sem e-mail para este aviso" : `sem ${CHANNEL_LABEL[c]} para este aviso`}`}
                                className="min-h-11 min-w-11 text-xs text-text-muted"
                              >
                                —
                              </button>
                            </Tooltip>
                          )}
                        </div>
                      ))}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          <p className="text-xs text-text-muted">
            Avisos que pedem uma ação sua ficam sempre no sino. Nos demais, ligar um canal também religa o sino
            daquele tipo.
          </p>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------- silêncio, urgente, prévia */

function DeliveryBlock({
  prefs,
  deviceTimeZone,
  onQuietHours,
  onUrgentBypass,
  onShowPreview,
}: NotificationPreferencesViewProps) {
  const q = prefs.quietHours;
  const [start, setStart] = useState(q.start);
  const [end, setEnd] = useState(q.end);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setStart(q.start);
    setEnd(q.end);
  }, [q.start, q.end]);

  const save = async (enabled: boolean, s: string, e: string) => {
    const problem = validateQuietHours(enabled, s, e);
    setError(problem);
    if (problem) return;
    try {
      // O fuso é o do aparelho, a menos que já exista um salvo e o silêncio esteja ligado.
      await onQuietHours({ enabled, start: s, end: e, timeZone: q.enabled ? q.timeZone : (deviceTimeZone ?? q.timeZone) });
      savedToast();
    } catch (err) {
      setError(mutationErrorMessage(err, "Não foi possível salvar o horário de silêncio."));
    }
  };

  const simple = async (fn: () => Promise<unknown>, rollback: () => void) => {
    try {
      await fn();
      savedToast();
    } catch (e) {
      rollback();
      failToast(e);
    }
  };

  const [urgent, setUrgent] = useState(prefs.urgentBypass);
  const [preview, setPreview] = useState(prefs.showPreview);
  useEffect(() => setUrgent(prefs.urgentBypass), [prefs.urgentBypass]);
  useEffect(() => setPreview(prefs.showPreview), [prefs.showPreview]);

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-3 mb-1">
          <Moon size={20} className="text-brand-500" aria-hidden="true" />
          <h3 className="text-lg font-semibold text-text-primary">Horário de silêncio</h3>
        </div>
        <p className="text-sm text-text-secondary mb-3">
          No horário de silêncio, e-mail, Telegram e push esperam; o sino continua registrando. Fuso:{" "}
          {q.enabled ? q.timeZone : (deviceTimeZone ?? q.timeZone)}.
        </p>
        <Switch
          checked={q.enabled}
          onCheckedChange={(v) => void save(v, start, end)}
          label="Silenciar em um horário"
        />
        <div className="mt-3 grid max-w-sm grid-cols-2 gap-3">
          <Input
            label="Início"
            type="time"
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              if (q.enabled) void save(true, e.target.value, end);
            }}
          />
          <Input
            label="Fim"
            type="time"
            value={end}
            onChange={(e) => {
              setEnd(e.target.value);
              if (q.enabled) void save(true, start, e.target.value);
            }}
          />
        </div>
        {error && (
          <p role="alert" className="mt-2 text-[13px] text-semantic-error">
            {error}
          </p>
        )}
      </div>

      <div className="flex items-start gap-3">
        <ShieldCheck size={20} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
        <Switch
          checked={urgent}
          onCheckedChange={(v) => {
            setUrgent(v);
            void simple(() => onUrgentBypass(v), () => setUrgent(!v));
          }}
          label="Pedido de ajuda urgente fura pausa e silêncio"
          description="Quando a IA pede ajuda com urgência, o aviso chega mesmo pausado ou no horário de silêncio."
        />
      </div>

      <div className="flex items-start gap-3">
        <Send size={20} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
        <Switch
          checked={prefs.orgHidePreview ? false : preview}
          disabled={prefs.orgHidePreview}
          onCheckedChange={(v) => {
            setPreview(v);
            void simple(() => onShowPreview(v), () => setPreview(!v));
          }}
          label="Mostrar prévia na tela de bloqueio"
          description={
            prefs.orgHidePreview
              ? "A organização ocultou a prévia na tela de bloqueio; o aviso chega sem o texto da mensagem."
              : "Desligado, o aviso chega só com o tipo, sem o texto da mensagem."
          }
        />
      </div>
    </div>
  );
}

/* ----------------------------------------------------- padrões da organização */

function OrgDefaultsBlock({ prefs, onOrgDefaults }: NotificationPreferencesViewProps) {
  const [preset, setPreset] = useState<Preset>(prefs.orgDefaults.preset ?? "all");
  const [hide, setHide] = useState(prefs.orgDefaults.hidePreviewOnLockScreen);
  useEffect(() => setPreset(prefs.orgDefaults.preset ?? "all"), [prefs.orgDefaults.preset]);
  useEffect(() => setHide(prefs.orgDefaults.hidePreviewOnLockScreen), [prefs.orgDefaults.hidePreviewOnLockScreen]);

  const save = async (nextPreset: Preset, nextHide: boolean) => {
    const before = { preset, hide };
    setPreset(nextPreset);
    setHide(nextHide);
    try {
      await onOrgDefaults({ preset: nextPreset, hidePreviewOnLockScreen: nextHide });
      savedToast();
    } catch (e) {
      setPreset(before.preset);
      setHide(before.hide);
      failToast(e);
    }
  };

  return (
    <div>
      <h3 className="text-lg font-semibold text-text-primary mb-1">Padrões da organização</h3>
      <p className="text-sm text-text-secondary mb-4">
        Valem para quem ainda não escolheu o próprio atalho. Só administradores veem esta parte.
      </p>
      <div role="radiogroup" aria-label="Atalho inicial da organização" className="grid gap-2 md:grid-cols-3">
        {PRESET_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={preset === o.value}
            onClick={() => void save(o.value, hide)}
            className={cn(
              "min-h-11 rounded-card border p-3 text-left transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
              preset === o.value
                ? "border-brand-500 bg-brand-500/10"
                : "border-border bg-surface-raised hover:bg-surface-overlay",
            )}
          >
            <span className="block text-sm font-medium text-text-primary">{o.label}</span>
          </button>
        ))}
      </div>
      <div className="mt-4">
        <Switch
          checked={hide}
          onCheckedChange={(v) => void save(preset, v)}
          label="Ocultar prévia na tela de bloqueio"
          description="Os avisos de todos chegam sem o texto da mensagem, mesmo para quem ligou a prévia."
        />
      </div>
    </div>
  );
}
