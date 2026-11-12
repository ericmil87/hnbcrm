import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as T from "./emailTemplates";

const EVIL = "<img src=x onerror=alert(1)>";
const EVIL_MULTI = `${EVIL}\r\nBcc: x@y.z`;

// Um caso por evento do dispatcher: TODO campo de texto = payload. Um template novo
// que interpole valor cru falha aqui (e o teste de cobertura abaixo obriga a cadastrar o caso).
const CASES: Record<string, Record<string, unknown>> = {
  invite: { memberName: EVIL, orgName: EVIL, email: EVIL, tempPassword: EVIL, loginUrl: "https://app.test/entrar" },
  handoffRequested: { orgName: EVIL, leadTitle: EVIL, origin: "human", reason: EVIL, fromIsHuman: true, pendingLabel: EVIL, fromMemberName: EVIL, leadUrl: "https://app.test/app/x" },
  handoffResolved: { leadTitle: EVIL, status: "aceito", resolvedByName: EVIL, leadUrl: "https://app.test/app/x" },
  taskOverdue: { taskTitle: EVIL, dueDate: EVIL, leadTitle: EVIL, taskUrl: "https://app.test/app/x" },
  taskOverdueSummary: { count: 2, tasks: [{ title: EVIL, dueDate: EVIL, taskUrl: "https://app.test/app/x" }], appUrl: "https://app.test" },
  taskAssigned: { taskTitle: EVIL, dueDate: EVIL, assignedByName: EVIL, leadTitle: EVIL, taskUrl: "https://app.test/app/x" },
  taskCommentMention: { authorName: EVIL, taskTitle: EVIL, taskId: EVIL, commentExcerpt: EVIL, appUrl: "https://app.test" },
  taskDueSoon: { taskTitle: EVIL, taskId: EVIL, dueDate: EVIL, minutesBefore: 30, appUrl: "https://app.test" },
  leadAssigned: { leadTitle: EVIL, value: EVIL, stage: EVIL, contactName: EVIL, assignedByName: EVIL, leadUrl: "https://app.test/app/x" },
  dailyDigest: { date: EVIL, orgName: EVIL, newLeadsCount: 1, completedTasksCount: 1, pendingHandoffsCount: 1, overdueTasksCount: 1, appUrl: "https://app.test" },
  formSubmission: { formName: EVIL, contactEmail: EVIL, contactName: EVIL, leadUrl: "https://app.test/app/x" },
  formConfirmation: { formName: EVIL, subject: EVIL, body: `${EVIL} {Nome}`, submittedData: { f1: EVIL }, fieldLabels: { f1: "Nome" } },
  groupPostPending: { postName: EVIL, postId: EVIL, groups: EVIL, scheduledFor: EVIL, text: EVIL, appUrl: "https://app.test" },
  groupPostFailed: { postName: EVIL, postId: EVIL, reason: EVIL, appUrl: "https://app.test" },
  aiSpendAlert: { level: "warn", orgName: EVIL, month: EVIL, costBrl: EVIL, capBrl: EVIL, pct: 80, mode: "warn", appUrl: "https://app.test" },
  planAlert: { orgName: EVIL, title: EVIL, body: EVIL, appUrl: "https://app.test" },
  channelSessionLost: { orgName: EVIL, channelName: EVIL, phoneDisplay: EVIL, state: EVIL, detail: EVIL },
  channelSessionLostMeta: { orgName: EVIL, channelName: EVIL, state: EVIL, detail: EVIL, provider: "meta_messaging" },
};

describe("emailTemplates: escape de HTML", () => {
  for (const [event, data] of Object.entries(CASES)) {
    it(`${event}: nenhum campo vira tag`, () => {
      const type = event === "channelSessionLostMeta" ? "channelSessionLost" : event;
      const { subject, html } = T.buildTemplate(type, data);
      // A casca tem UMA <img> (logo da marca, URL fixa); qualquer outra vinda de dado é falha.
      expect(html.replace(/<img class="em-logo"[^>]*\/>/, "")).not.toContain("<img");
      expect(html.match(/<img\b/g)?.length).toBe(1);
      expect(html).not.toContain("onerror=alert(1)>");
      expect(subject).not.toMatch(/[\r\n]/);
    });
  }

  it("cobre todo eventType do dispatcher", () => {
    const src = readFileSync(new URL("./emailTemplates.ts", import.meta.url), "utf8");
    const events = [...src.matchAll(/case "(\w+)":\n\s+return build/g)].map((m) => m[1]);
    expect(events.length).toBeGreaterThan(10);
    for (const e of events) expect(CASES[e], `falta caso para ${e}`).toBeDefined();
  });

  it("assunto não tem quebra de linha", () => {
    const { subject } = T.buildTemplate("leadAssigned", { ...CASES.leadAssigned, leadTitle: EVIL_MULTI });
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it("href só aceita https/localhost/caminho do app e é escapado", () => {
    expect(T.ctaButton("x", "javascript:alert(1)")).toContain('href="#"');
    expect(T.ctaButton("x", "//evil.com")).toContain('href="#"');
    expect(T.ctaButton("x", 'https://a.test/"onmouseover="x')).toContain("&quot;onmouseover");
    expect(T.ctaButton("x", "https://a.test/app/x")).toContain('href="https://a.test/app/x"');
    expect(T.ctaButton("x", "/app/tarefas")).toContain('href="/app/tarefas"');
  });
});
