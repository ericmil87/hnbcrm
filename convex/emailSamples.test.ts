/**
 * Gera HTML de amostra dos e-mails para conferência visual. Só escreve arquivo quando
 * EMAIL_SAMPLES_DIR está definida (ex.: EMAIL_SAMPLES_DIR=/tmp/x npx vitest run convex/emailSamples.test.ts).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildEmailVerificationTemplate, buildWelcomeTemplate } from "./authEmailTemplates";
import { buildHandoffRequestedTemplate } from "./emailTemplates";

test("amostras de e-mail (só com EMAIL_SAMPLES_DIR)", () => {
  const samples = {
    welcome: buildWelcomeTemplate({ memberName: "fulano@dominio.com", orgName: "Clínica Aurora", appUrl: "https://hnbcrm.com" }),
    code: buildEmailVerificationTemplate({ code: "482915", expiresMinutes: 10 }),
    handoff: buildHandoffRequestedTemplate({
      orgName: "Clínica Aurora",
      leadTitle: "Marina Costa +55 11 91234-5678",
      origin: "ai_tool",
      fromMemberName: "Atendente IA",
      leadUrl: "https://hnbcrm.com/app/repasses?handoff=abc",
    }),
  };
  for (const s of Object.values(samples)) expect(s.html).toContain("<html");
  const dir = process.env.EMAIL_SAMPLES_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(samples)) writeFileSync(join(dir, `${k}.html`), v.html);
});
