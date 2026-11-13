import { describe, expect, it } from "vitest";
import {
  decideOnboardingEntry,
  newOrgTrialNotice,
  optionDiscardsIntent,
  stepLabelFor,
  type EntryInput,
  type EntryOrg,
  type EntryOverview,
} from "./onboardingEntryChoice";

const org = (id: string, extra: Partial<EntryOrg> = {}): EntryOrg => ({
  organizationId: id,
  name: `Empresa ${id}`,
  canManage: true,
  configured: false,
  conversation: "none",
  reachedStep: 0,
  readOnly: false,
  spendCapReached: false,
  ...extra,
});
const overview = (...orgs: EntryOrg[]): EntryOverview => ({ orgs, newOrgTrial: "fresh", newOrgTrialEndsAt: null });
const signedIn = (o: EntryOverview, extra: Partial<EntryInput> = {}): EntryInput => ({
  auth: "signed_in",
  overview: o,
  storedOrgId: null,
  hasIntent: false,
  ...extra,
});

describe("decideOnboardingEntry", () => {
  it("carregando: auth ou resumo ainda não chegou", () => {
    expect(decideOnboardingEntry({ auth: "loading", overview: undefined, storedOrgId: null, hasIntent: true })).toEqual({ kind: "loading" });
    expect(decideOnboardingEntry({ auth: "signed_in", overview: undefined, storedOrgId: null, hasIntent: false })).toEqual({ kind: "loading" });
  });

  it("(a) deslogado: entrar ou criar conta", () => {
    expect(decideOnboardingEntry({ auth: "signed_out", overview: undefined, storedOrgId: null, hasIntent: true })).toEqual({ kind: "signed_out" });
  });

  it("(b) logado sem organização: criar a primeira", () => {
    expect(decideOnboardingEntry(signedIn(overview(), { hasIntent: true }))).toEqual({ kind: "create_org", reason: "no_org" });
  });

  it("(c) uma org nova, sem nada: direto para a conversa (com ou sem mensagem do hero)", () => {
    expect(decideOnboardingEntry(signedIn(overview(org("a")), { hasIntent: true }))).toEqual({ kind: "conversation", orgId: "a" });
    expect(decideOnboardingEntry(signedIn(overview(org("a"))))).toEqual({ kind: "conversation", orgId: "a" });
  });

  it("(c) uma org já configurada (assistente, legada, atendente, canal ou leads): escolha com Abrir o meu CRM em primeiro", () => {
    const d = decideOnboardingEntry(signedIn(overview(org("a", { configured: true })), { hasIntent: true }));
    expect(d).toMatchObject({ kind: "choose", primary: "open_crm", options: ["open_crm", "adjust", "create"], notice: null });
  });

  it("(d) conversa pela metade sem mensagem do hero: retoma direto", () => {
    expect(decideOnboardingEntry(signedIn(overview(org("a", { conversation: "in_progress", reachedStep: 2 }))))).toEqual({
      kind: "conversation",
      orgId: "a",
    });
  });

  it("(d) conversa pela metade COM mensagem do hero: pergunta antes (pode ser outra empresa) e diz onde parou", () => {
    const d = decideOnboardingEntry(signedIn(overview(org("a", { conversation: "in_progress", reachedStep: 2 })), { hasIntent: true }));
    expect(d).toMatchObject({ kind: "choose", primary: "continue", options: ["continue", "open_crm", "create"], stepLabel: "Atendente" });
  });

  it("(d) conversa pela metade numa org que já opera: escolha, nunca direto", () => {
    const d = decideOnboardingEntry(signedIn(overview(org("a", { conversation: "in_progress", configured: true }))));
    expect(d).toMatchObject({ kind: "choose", primary: "continue" });
  });

  it("(e) conversa aplicada: escolha com Abrir o meu CRM e Ajustar", () => {
    const d = decideOnboardingEntry(signedIn(overview(org("a", { conversation: "applied", configured: true }))));
    expect(d).toMatchObject({ kind: "choose", primary: "open_crm", options: ["open_crm", "adjust", "create"] });
  });

  it("(f) várias orgs: a última usada (se administra) vem pré-selecionada; o seletor lista só as que administra", () => {
    const o = overview(org("a"), org("b", { configured: true }), org("c", { canManage: false }));
    const d = decideOnboardingEntry(signedIn(o, { storedOrgId: "b" }));
    expect(d.kind).toBe("choose");
    if (d.kind !== "choose") return;
    expect(d.org.organizationId).toBe("b");
    expect(d.managed.map((m) => m.organizationId)).toEqual(["a", "b"]);
  });

  it("(f) a salva é uma em que não administra: cai na primeira que administra", () => {
    const o = overview(org("a", { canManage: false }), org("b"), org("c"));
    const d = decideOnboardingEntry(signedIn(o, { storedOrgId: "a" }));
    expect(d).toMatchObject({ kind: "choose", org: { organizationId: "b" }, primary: "start" });
  });

  it("(f) org escolhida no seletor vence a salva e nunca vai direto", () => {
    const o = overview(org("a"), org("b", { canManage: false }));
    const d = decideOnboardingEntry(signedIn(o, { storedOrgId: "a", pickedOrgId: "a" }));
    expect(d).toMatchObject({ kind: "choose", org: { organizationId: "a" } });
  });

  it("(g) não administrador de nenhuma: explica e oferece abrir o CRM ou criar a própria empresa", () => {
    const o = overview(org("a", { canManage: false }), org("b", { canManage: false }));
    expect(decideOnboardingEntry(signedIn(o, { storedOrgId: "b", hasIntent: true }))).toEqual({
      kind: "not_admin",
      orgName: "Empresa b",
      options: ["open_crm", "create"],
    });
  });

  it("(g) não administra a salva mas administra outra (só uma, nova): vai direto para a que administra", () => {
    const o = overview(org("a", { canManage: false }), org("b"));
    expect(decideOnboardingEntry(signedIn(o, { storedOrgId: "a" }))).toEqual({ kind: "conversation", orgId: "b" });
  });

  it("(h) modo leitura ou teto de IA: nunca direto; próximo passo é ver o plano ou o uso", () => {
    expect(decideOnboardingEntry(signedIn(overview(org("a", { readOnly: true }))))).toMatchObject({
      kind: "choose",
      notice: "read_only",
      primary: "see_plan",
      options: ["see_plan", "open_crm", "create"],
    });
    expect(decideOnboardingEntry(signedIn(overview(org("a", { spendCapReached: true, conversation: "in_progress" }))))).toMatchObject({
      kind: "choose",
      notice: "spend_cap",
      primary: "see_usage",
    });
  });

  it("escolhas da visita: criar outra; conversa numa org (espera a org nova aparecer no resumo)", () => {
    const o = overview(org("a", { configured: true }));
    expect(decideOnboardingEntry(signedIn(o, { choice: { action: "create" } }))).toEqual({ kind: "create_org", reason: "chosen" });
    expect(decideOnboardingEntry(signedIn(o, { choice: { action: "conversation", orgId: "a" } }))).toEqual({ kind: "conversation", orgId: "a" });
    expect(decideOnboardingEntry(signedIn(o, { choice: { action: "conversation", orgId: "nova" } }))).toEqual({ kind: "loading" });
    // Escolha de conversa numa org que a pessoa não administra não vale.
    const o2 = overview(org("a"), org("b", { canManage: false }));
    expect(decideOnboardingEntry(signedIn(o2, { choice: { action: "conversation", orgId: "b" } }))).toEqual({ kind: "loading" });
  });
});

describe("textos da entrada", () => {
  it("etapa em que parou", () => {
    expect(stepLabelFor(0)).toBe("Negócio");
    expect(stepLabelFor(99)).toBe("Conectar");
    expect(stepLabelFor(Number.NaN)).toBe("Negócio");
  });

  it("teste grátis numa empresa nova", () => {
    expect(newOrgTrialNotice("fresh", null)).toMatch(/30 dias de teste/);
    expect(newOrgTrialNotice("shared_active", Date.UTC(2026, 11, 10, 15))).toMatch(/mesmo teste, que termina em 10\/12\/2026/);
    expect(newOrgTrialNotice("shared_expired", 1)).toMatch(/modo leitura/);
    expect(newOrgTrialNotice("none", null)).toMatch(/do zero/);
  });

  it("só Abrir o meu CRM descarta a mensagem do hero", () => {
    expect(optionDiscardsIntent("open_crm")).toBe(true);
    for (const o of ["continue", "adjust", "start", "create", "see_plan", "see_usage"] as const) expect(optionDiscardsIntent(o)).toBe(false);
  });
});
