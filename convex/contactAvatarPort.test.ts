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

test("o gatilho do ingest só lê contactAvatars: canal e cursor ficam em scheduleContactAvatarFetch", () => {
  const ops = files.find((f) => f.rel === "lib/contactAvatarOps.ts")!.text;
  const start = ops.indexOf("export async function maybeScheduleContactAvatar");
  const end = ops.indexOf("export type ScheduleOutcome");
  const trigger = ops.slice(start, end);
  expect(trigger).toContain("internal.contactAvatar.internalMaybeSchedule");
  expect(trigger).toContain("try {");
  expect(trigger).not.toContain("channelAvatarPacing");
  expect(trigger).not.toContain("ctx.db.patch");
  expect(trigger).not.toContain("ctx.db.insert");
  expect(trigger).not.toContain("ctx.db.get(");
  // Só o gatilho agenda a mutation de agendamento.
  const offenders = files
    .filter((f) => f.text.includes("internal.contactAvatar.internalMaybeSchedule") && f.rel !== "lib/contactAvatarOps.ts")
    .map((f) => f.rel);
  expect(offenders).toEqual([]);
});

test("a purga da org e o rollback de importação conhecem a foto de perfil", () => {
  expect(files.find((f) => f.rel === "opsPurge.ts")!.text).toContain('table: "contactAvatars"');
  expect(files.find((f) => f.rel === "imports.ts")!.text).toContain("deleteContactAvatarArtifacts");
});

test("foto de GRUPO: uma porta de agendamento, gatilhos conhecidos e gatilho sem nenhuma leitura", () => {
  const offenders = files
    .filter(
      (f) =>
        (f.text.includes("internalFetchGroupAvatar") || f.text.includes("internal.groupAvatar.internalMaybeScheduleGroup")) &&
        !["lib/groupAvatarOps.ts", "groupAvatar.ts"].includes(f.rel)
    )
    .map((f) => f.rel);
  expect(offenders).toEqual([]);
  const callers = files.filter((f) => /maybeScheduleGroupAvatar\(/.test(f.text) && f.rel !== "lib/groupAvatarOps.ts");
  expect(callers.map((f) => f.rel).sort()).toEqual(["conversations.ts", "groupChats.ts"]);
  expect(callers.find((f) => f.rel === "conversations.ts")!.text.match(/maybeScheduleGroupAvatar\(/g)).toHaveLength(2);
  expect(callers.find((f) => f.rel === "groupChats.ts")!.text.match(/maybeScheduleGroupAvatar\(/g)).toHaveLength(2);
  const ops = files.find((f) => f.rel === "lib/groupAvatarOps.ts")!.text;
  const trigger = ops.slice(ops.indexOf("export async function maybeScheduleGroupAvatar"), ops.indexOf("export async function stampGroupAvatar"));
  expect(trigger).toContain("try {");
  expect(trigger).not.toContain("ctx.db");
  // O ingest de grupo não lê `groupAvatars`: decide pelo carimbo do doc que já tem.
  const conv = files.find((f) => f.rel === "conversations.ts")!.text;
  expect(conv).not.toContain('"groupAvatars"');
});

test("foto de GRUPO: exclusão, purga da org e backup conhecem a tabela e os campos derivados", () => {
  expect(files.find((f) => f.rel === "groupChats.ts")!.text).toContain("deleteGroupAvatarRows");
  expect(files.find((f) => f.rel === "opsPurge.ts")!.text).toContain('table: "groupAvatars"');
  const sanitize = files.find((f) => f.rel === "lib/exportSanitize.ts")!.text;
  expect(sanitize).toContain('"groupAvatars"');
  expect(sanitize).toContain('"conversations.groupAvatarUrl"');
  expect(sanitize).toContain('"groupChats.avatarNextCheckAt"');
});

test("foto do Instagram/Messenger: só o ingest Meta chama a renovação e só uma função fala com o perfil", () => {
  const callers = files.filter((f) => /refreshMetaContactAvatar\(/.test(f.text) && f.rel !== "lib/metaAvatarOps.ts");
  expect(callers.map((f) => f.rel)).toEqual(["metaMessaging.ts"]);
  const profileCallers = files.filter((f) => /fetchMetaProfile\(/.test(f.text) && f.rel !== "lib/metaAvatarOps.ts");
  expect(profileCallers.map((f) => f.rel)).toEqual(["metaMessaging.ts"]);
  // Nunca guarda a URL do CDN no contato: só o arquivo do storage.
  expect(files.filter((f) => /avatarUrl:\s*[a-z.]*picUrl/.test(f.text)).map((f) => f.rel)).toEqual([]);
});
