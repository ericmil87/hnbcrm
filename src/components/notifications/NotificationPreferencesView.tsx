import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { BellOff, Lock, Moon, Send, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { mutationErrorMessage } from "@/lib/errors";
import {
  PAUSE_OPTIONS,
  PRESET_OPTIONS,
  buildMatrixGroups,
  externalChannelsText,
  isCustomized,
  isPaused,
  pausedUntilLabel,
  validateQuietHours,
  type MatrixChannel,
} from "@/lib/notificationPrefsUi";
import { timezoneLabel } from "@/lib/timezones";
import { NOTIFICATION_GROUP_LABELS } from "../../../convex/lib/notificationGroups";

export type Preset = "all" | "mine" | "none";
export type PauseMode = "1h" | "4h" | "tomorrow";

/** Formato exato devolvido pelo servidor. */
export type EffectivePrefs = FunctionReturnType<typeof api.notificationPreferences.getMyEffectivePreferences>;

export interface QuietHoursInput {
  enabled: boolean;
  start?: string;
  end?: string;
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
  /**
   * `PUSH_ENABLED`: só com push existem avisos no aparelho. Sem ele a prévia na tela de bloqueio
   * não aparece e os textos de pausa/silêncio não citam push.
   */
  previewEnabled: boolean;
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

/* ------------------------------------------------- palpites otimistas da matriz */

/**
 * Palpite local por célula (`canal:flag`). Cada toque ganha uma versão: o fim (sucesso ou erro)
 * de um toque antigo não mexe no palpite de um toque mais novo.
 */
function useChannelOverrides(onChannel: NotificationPreferencesViewProps["onChannel"]) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const versions = useRef(new Map<string, number>());

  const drop = useCallback((key: string) => {
    setOverrides((p) => {
      if (!(key in p)) return p;
      const rest = { ...p };
      delete rest[key];
      return rest;
    });
  }, []);

  const toggle = useCallback(
    async (channel: MatrixChannel, flag: string, enabled: boolean) => {
      const key = `${channel}:${flag}`;
      const version = (versions.current.get(key) ?? 0) + 1;
      versions.current.set(key, version);
      setOverrides((p) => ({ ...p, [key]: enabled }));
      try {
        await onChannel(channel, flag, enabled);
        if (versions.current.get(key) === version) drop(key);
        savedToast();
      } catch (e) {
        if (versions.current.get(key) === version) drop(key);
        failToast(e);
      }
    },
    [onChannel, drop],
  );

  /** Um atalho recomeça a matriz: palpites e respostas pendentes deixam de valer. */
  const reset = useCallback(() => {
    for (const key of versions.current.keys()) versions.current.set(key, (versions.current.get(key) ?? 0) + 1);
    setOverrides({});
  }, []);

  return { overrides, toggle, reset };
}

export function NotificationPreferencesView(props: NotificationPreferencesViewProps) {
  const { prefs, now, canManageOrg } = props;
  const paused = isPaused(prefs.pausedUntil, now);
  const groups = useMemo(() => buildMatrixGroups(), []);
  const { overrides, toggle, reset } = useChannelOverrides(props.onChannel);

  const valueOf = (channel: MatrixChannel, flag: string) =>
    overrides[`${channel}:${flag}`] ?? prefs.channels[channel]?.[flag] ?? false;
  const customized = isCustomized(
    prefs.preset,
    valueOf,
    groups.flatMap((g) => g.rows),
  );

  return (
    <div className="space-y-6">
      <Card>
        <PauseBlock {...props} paused={paused} />
      </Card>
      <Card>
        <PresetBlock {...props} customized={customized} onApplied={reset} />
      </Card>
      <Card>
        <MatrixBlock {...props} groups={groups} valueOf={valueOf} onToggle={toggle} />
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
  previewEnabled,
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
        Enquanto estiver pausado, nada sai por {externalChannelsText(previewEnabled)}; tudo fica registrado no sino.
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

function PresetBlock({
  prefs,
  customized,
  onApplied,
  onPreset,
  onApplyAll,
}: NotificationPreferencesViewProps & { customized: boolean; onApplied: () => void }) {
  const [optimistic, setOptimistic] = useState<Preset | null>(null);
  const version = useRef(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const selected = optimistic ?? prefs.preset;

  useEffect(() => {
    if (optimistic !== null && optimistic === prefs.preset) setOptimistic(null);
  }, [optimistic, prefs.preset]);

  // Tocar no atalho já escolhido reaplica: apaga as escolhas por tipo.
  const choose = async (preset: Preset) => {
    const mine = ++version.current;
    setOptimistic(preset);
    try {
      await onPreset(preset);
      onApplied();
      if (version.current === mine) setOptimistic(null);
      savedToast();
    } catch (e) {
      if (version.current === mine) setOptimistic(null);
      failToast(e);
    }
  };

  const applyAll = async () => {
    if (applying) return;
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

  const hint = PRESET_OPTIONS.find((o) => o.value === selected)?.hint;

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold text-text-primary">O que você quer receber</h3>
        {customized && <Badge variant="info">Personalizado</Badge>}
      </div>
      <p className="text-sm text-text-secondary mb-4">
        Escolha um atalho. Tocar de novo no atalho atual apaga os ajustes por tipo de "Personalizar". O sino sempre
        registra o que precisa de você.
        {prefs.presetSource === "org" && " Hoje vale o padrão da organização."}
      </p>
      <SegmentedControl
        ariaLabel="O que você quer receber"
        value={selected}
        onValueChange={(v) => void choose(v as Preset)}
        options={PRESET_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      />
      {hint && (
        <p className="mt-2 text-xs text-text-secondary">
          {hint}
          {customized && " Há ajustes por tipo em “Personalizar”."}
        </p>
      )}
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

function MatrixBlock({
  prefs,
  telegramLinked,
  pushAvailable,
  groups,
  valueOf,
  onToggle,
}: NotificationPreferencesViewProps & {
  groups: ReturnType<typeof buildMatrixGroups>;
  valueOf: (channel: MatrixChannel, flag: string) => boolean;
  onToggle: (channel: MatrixChannel, flag: string, enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);

  const columns = useMemo<MatrixChannel[]>(() => {
    const cols: MatrixChannel[] = ["email"];
    if (telegramLinked) cols.push("telegram");
    if (pushAvailable) cols.push("push");
    return cols;
  }, [telegramLinked, pushAvailable]);

  const colClass = [
    "md:grid",
    columns.length === 1 && "md:grid-cols-[minmax(0,1fr)_72px_72px]",
    columns.length === 2 && "md:grid-cols-[minmax(0,1fr)_72px_72px_72px]",
    columns.length === 3 && "md:grid-cols-[minmax(0,1fr)_72px_72px_72px_72px]",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-text-primary mb-1">Personalizar</h3>
          <p className="text-sm text-text-secondary">Escolha, tipo por tipo, onde cada aviso chega. Salva ao tocar.</p>
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
          <div className={`hidden gap-2 border-b border-border pb-2 text-xs font-medium text-text-muted ${colClass}`}>
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
              <h4 id={`matrix-${group}`} className="mb-1 text-xs font-medium uppercase tracking-wider text-text-muted">
                {NOTIFICATION_GROUP_LABELS[group]}
              </h4>
              <ul className="divide-y divide-border">
                {rows.map((row) => {
                  const actionable = prefs.actionableFlags.includes(row.flag);
                  const bellOn = actionable || (prefs.channels.bell[row.flag] ?? true);
                  return (
                    <li key={row.flag} className={`grid grid-cols-1 gap-2 py-3 md:items-center ${colClass}`}>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text-primary">{row.label}</p>
                        <p className="text-xs text-text-secondary">{row.desc}</p>
                      </div>
                      <div className="flex items-center justify-between gap-2 md:justify-center">
                        <span className="text-xs text-text-muted md:hidden">Sino</span>
                        {!row.bell ? (
                          <NoCell text={`${row.label}: não aparece no sino`} />
                        ) : actionable ? (
                          <span className="inline-flex min-h-11 items-center gap-1 text-xs text-text-secondary">
                            <Lock size={14} aria-hidden="true" />
                            Sempre
                            <span className="sr-only">
                              {` no sino: ${row.label} precisa de uma ação sua e não pode ser desligado`}
                            </span>
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
                              onCheckedChange={(v) => onToggle(c, row.flag, v)}
                              label={`${row.label}: ${CHANNEL_LABEL[c]}`}
                              hideLabel
                              size="sm"
                            />
                          ) : (
                            <NoCell text={`${row.label}: sem ${c === "email" ? "e-mail" : CHANNEL_LABEL[c]} para este aviso`} />
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
            daquele tipo. “—” indica que o aviso não existe naquele canal.
          </p>
        </div>
      )}
    </div>
  );
}

/** Célula sem canal: traço visual, texto só para leitor de tela, fora da ordem do Tab. */
function NoCell({ text }: { text: string }) {
  return (
    <span className="inline-flex min-h-11 min-w-11 items-center justify-center text-xs text-text-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

/* ---------------------------------------------- silêncio, urgente, prévia */

function DeliveryBlock({
  prefs,
  deviceTimeZone,
  previewEnabled,
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

  const zone = q.enabled ? q.timeZone : (deviceTimeZone ?? q.timeZone);

  const save = async (input: QuietHoursInput) => {
    try {
      await onQuietHours(input);
      savedToast();
    } catch (err) {
      setError(mutationErrorMessage(err, "Não foi possível salvar o horário de silêncio."));
    }
  };

  const toggleQuiet = (enabled: boolean) => {
    if (!enabled) {
      // Desligar nunca depende dos campos (podem estar vazios ou inválidos).
      setError(null);
      void save({ enabled: false });
      return;
    }
    const problem = validateQuietHours(true, start, end);
    setError(problem);
    if (problem) return;
    void save({ enabled: true, start, end, timeZone: zone });
  };

  // Valida ao digitar; grava ao sair do campo (a roleta do iPhone dispara vários onChange).
  const check = (s: string, e: string) => setError(q.enabled ? validateQuietHours(true, s, e) : null);
  const commit = () => {
    if (!q.enabled) return;
    if (start === q.start && end === q.end) return;
    const problem = validateQuietHours(true, start, end);
    setError(problem);
    if (problem) return;
    void save({ enabled: true, start, end, timeZone: q.timeZone });
  };

  const [urgent, setUrgent] = useState(prefs.urgentBypass);
  const [preview, setPreview] = useState(prefs.showPreview);
  useEffect(() => setUrgent(prefs.urgentBypass), [prefs.urgentBypass]);
  useEffect(() => setPreview(prefs.showPreview), [prefs.showPreview]);

  const simple = async (fn: () => Promise<unknown>, rollback: () => void) => {
    try {
      await fn();
      savedToast();
    } catch (e) {
      rollback();
      failToast(e);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-3 mb-1">
          <Moon size={20} className="text-brand-500" aria-hidden="true" />
          <h3 className="text-lg font-semibold text-text-primary">Horário de silêncio</h3>
        </div>
        <p className="text-sm text-text-secondary mb-3">
          No horário de silêncio, nada sai por {externalChannelsText(previewEnabled)}; tudo fica registrado no sino.
          Fuso: {timezoneLabel(zone)}.
        </p>
        <Switch checked={q.enabled} onCheckedChange={toggleQuiet} label="Silenciar em um horário" />
        <div className="mt-3 grid max-w-sm grid-cols-2 gap-3">
          <Input
            label="Início"
            type="time"
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              check(e.target.value, end);
            }}
            onBlur={commit}
          />
          <Input
            label="Fim"
            type="time"
            value={end}
            onChange={(e) => {
              setEnd(e.target.value);
              check(start, e.target.value);
            }}
            onBlur={commit}
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
            void simple(
              () => onUrgentBypass(v),
              () => setUrgent(!v),
            );
          }}
          label="Pedido de ajuda urgente fura pausa e silêncio"
          description="Quando a IA pede ajuda com urgência, o aviso chega mesmo pausado ou no horário de silêncio."
        />
      </div>

      {previewEnabled && (
        <div className="flex items-start gap-3">
          <Send size={20} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
          <Switch
            checked={prefs.orgHidePreview ? false : preview}
            disabled={prefs.orgHidePreview}
            onCheckedChange={(v) => {
              setPreview(v);
              void simple(
                () => onShowPreview(v),
                () => setPreview(!v),
              );
            }}
            label="Mostrar prévia na tela de bloqueio"
            description={
              prefs.orgHidePreview
                ? "A organização ocultou a prévia na tela de bloqueio; o aviso chega sem o texto da mensagem."
                : "Vale para os avisos no aparelho. Desligado, o aviso chega só com o tipo, sem o texto da mensagem."
            }
          />
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------- padrões da organização */

function OrgDefaultsBlock({ prefs, previewEnabled, onOrgDefaults }: NotificationPreferencesViewProps) {
  // `null` = a organização ainda não escolheu; nada fica marcado até um admin escolher.
  const [preset, setPreset] = useState<Preset | null>(prefs.orgDefaults.preset);
  const [hide, setHide] = useState(prefs.orgDefaults.hidePreviewOnLockScreen);
  useEffect(() => setPreset(prefs.orgDefaults.preset), [prefs.orgDefaults.preset]);
  useEffect(() => setHide(prefs.orgDefaults.hidePreviewOnLockScreen), [prefs.orgDefaults.hidePreviewOnLockScreen]);

  const save = async (nextPreset: Preset | null, nextHide: boolean) => {
    const before = { preset, hide };
    setPreset(nextPreset);
    setHide(nextHide);
    try {
      // O servidor exige um atalho; sem escolha da organização vale "Tudo", que já é o comportamento padrão.
      await onOrgDefaults({ preset: nextPreset ?? "all", hidePreviewOnLockScreen: nextHide });
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
      <SegmentedControl
        ariaLabel="Atalho inicial da organização"
        value={preset ?? ""}
        onValueChange={(v) => void save(v as Preset, hide)}
        options={PRESET_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      />
      {previewEnabled && (
        <div className="mt-4">
          <Switch
            checked={hide}
            onCheckedChange={(v) => void save(preset, v)}
            label="Ocultar prévia na tela de bloqueio"
            description="Vale para os avisos no aparelho de todos: chegam sem o texto da mensagem, mesmo para quem ligou a prévia."
          />
        </div>
      )}
    </div>
  );
}
