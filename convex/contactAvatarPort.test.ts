// @vitest-environment node
/**
 * Guarda de build da foto de perfil: o agendamento da busca tem UMA porta
 * (`maybeScheduleContactAvatar`) e o contato nunca recebe a URL do WhatsApp.
 */
import { expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "_generated" || name === "node_modules") return [];
    if (statSync(full).isDirectory()) return sources(full);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

const files = sources(__dirname).map((f) => ({ rel: path.relative(__dirname, f), text: readFileSync(f, "utf8") }));

test("só lib/contactAvatarOps.ts agenda internalFetchContactAvatar", () => {
  const offenders = files
    .filter((f) => f.text.includes("internalFetchContactAvatar") && !["lib/contactAvatarOps.ts", "contactAvatar.ts"].includes(f.rel))
    .map((f) => f.rel);
  expect(offenders).toEqual([]);
  const ops = files.find((f) => f.rel === "lib/contactAvatarOps.ts")!;
  expect(ops.text).toContain("internal.contactAvatar.internalFetchContactAvatar");
});

test("a busca é chamada só pelos dois gatilhos (mensagem recebida 1 a 1 e conversa aberta)", () => {
  const callers = files.filter((f) => /maybeScheduleContactAvatar\(/.test(f.text) && f.rel !== "lib/contactAvatarOps.ts");
  expect(callers.map((f) => f.rel)).toEqual(["conversations.ts"]);
  expect(callers[0].text.match(/maybeScheduleContactAvatar\(/g)).toHaveLength(2);
});

test("nenhum módulo grava pps.whatsapp.net em contato", () => {
  const offenders = files
    .filter((f) => /avatarUrl:\s*[a-z.]*parsed\.url/.test(f.text))
    .map((f) => f.rel);
  expect(offenders).toEqual([]);
});
