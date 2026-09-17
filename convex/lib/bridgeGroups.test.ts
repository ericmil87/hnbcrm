/// <reference types="vite/client" />
/**
 * Adapter puro das rotas `/group/*` do wuzapi.
 *
 * O valor destes testes está nas TRÊS pegadinhas medidas no gateway real, que
 * são exatamente as que derrubariam a sincronização em produção:
 *   1. instância sem grupo devolve `Groups: null` (não `[]`);
 *   2. `ParticipantCount` vem 0 na listagem;
 *   3. JID inválido responde HTTP 500 **com `success: true`**.
 */
import { describe, expect, test } from "vitest";
import groupListFixture from "../__fixtures__/bridgeGroupList.json";
import {
  buildGroupInfoRequest,
  buildGroupInviteInfoRequest,
  buildGroupJoinRequest,
  buildGroupLeaveRequest,
  buildGroupListRequest,
  buildUserLidRequest,
  inviteCodeFromLink,
  isGroupJid,
  jidToPhoneDigits,
  parseGroupAckResponse,
  parseGroupInfoResponse,
  parseGroupInfoStruct,
  parseGroupListResponse,
  parseUserLidResponse,
  participantKey,
  weAreAdminOf,
} from "./bridgeGroups";

const BASE = "https://wa-gw.example.test";
const TOKEN = "instance-token";
const GROUP_JID = "120363431849092219@g.us";
// Cláudio (nós) e Eric, do grupo real medido.
const OUR_LID = "92965187932215@lid";
const ADMIN_LID = "180002129735765@lid";

describe("JID helpers", () => {
  test("isGroupJid distingue sala de contato", () => {
    expect(isGroupJid(GROUP_JID)).toBe(true);
    expect(isGroupJid("558181392929@s.whatsapp.net")).toBe(false);
    expect(isGroupJid(undefined)).toBe(false);
  });

  test("jidToPhoneDigits NUNCA converte @g.us nem @lid", () => {
    // Um "telefone" 120363431849092219 seria um MSISDN inventado — foi esta a
    // armadilha apontada no levantamento (lacuna (d) da §13 do plano).
    expect(jidToPhoneDigits(GROUP_JID)).toBeUndefined();
    expect(jidToPhoneDigits(OUR_LID)).toBeUndefined();
    expect(jidToPhoneDigits("558181392929@s.whatsapp.net")).toBe("558181392929");
    expect(jidToPhoneDigits("558181392929.0:14@s.whatsapp.net")).toBe("558181392929");
  });

  test("participantKey prefere o LID (chave estável que casa com Info.Sender)", () => {
    expect(participantKey({ lid: OUR_LID, phone: "558192985729" })).toBe(OUR_LID);
    expect(participantKey({ phone: "558192985729" })).toBe("558192985729");
    expect(participantKey({})).toBeUndefined();
  });
});

describe("parseGroupListResponse — fixture REAL do gateway", () => {
  test("lê o grupo medido, com LID e telefone de cada participante", () => {
    const res = parseGroupListResponse(true, 200, groupListFixture);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.groups).toHaveLength(1);
    const group = res.groups[0];
    expect(group.jid).toBe(GROUP_JID);
    expect(group.subject).toBe("Grupo-Teste-Eric");
    expect(group.addressingMode).toBe("lid");
    expect(group.isEphemeral).toBe(true);
    expect(group.disappearingTimer).toBe(7776000);
    expect(group.ownerJid).toBe(ADMIN_LID);
    expect(group.participants).toEqual([
      { lid: OUR_LID, phone: "558192985729", isAdmin: false, isSuperAdmin: false },
      { lid: ADMIN_LID, phone: "558181392929", isAdmin: true, isSuperAdmin: true },
    ]);
  });

  test("PEGADINHA: ParticipantCount vem 0 na listagem — contamos a lista", () => {
    expect((groupListFixture as any).data.Groups[0].ParticipantCount).toBe(0);
    const res = parseGroupListResponse(true, 200, groupListFixture);
    expect(res.ok && res.groups[0].participantsCount).toBe(2);
  });

  test("PEGADINHA: instância sem grupo devolve Groups:null — lista vazia, não erro", () => {
    const res = parseGroupListResponse(true, 200, { code: 200, data: { Groups: null }, success: true });
    expect(res).toEqual({ ok: true, groups: [] });
  });

  test("PEGADINHA: data:null também é lista vazia", () => {
    expect(parseGroupListResponse(true, 200, { code: 200, data: null, success: true })).toEqual({
      ok: true,
      groups: [],
    });
  });

  test("HTTP de erro vira falha legível", () => {
    const res = parseGroupListResponse(false, 401, { error: "unauthorized" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("unauthorized");
  });

  test("TopicSetAt zero do Go não vira data", () => {
    const res = parseGroupListResponse(true, 200, groupListFixture);
    // O grupo real tem Topic vazio; o que importa é não explodir nem inventar.
    expect(res.ok && res.groups[0].topic).toBeUndefined();
    expect(res.ok && res.groups[0].createdAtWa).toBeGreaterThan(0);
  });
});

describe("parseGroupInfoResponse", () => {
  test("PEGADINHA: HTTP 500 com success:true é FALHA, não sucesso", () => {
    // JID inexistente no gateway real responde exatamente assim. Ler o corpo e
    // acreditar no `success` faria a varredura gravar um grupo vazio.
    const res = parseGroupInfoResponse(false, 500, { code: 500, data: null, success: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("500");
  });

  test("aceita o grupo direto em data", () => {
    const single = (groupListFixture as any).data.Groups[0];
    const res = parseGroupInfoResponse(true, 200, { code: 200, data: single, success: true });
    expect(res.ok).toBe(true);
    expect(res.ok && res.group.subject).toBe("Grupo-Teste-Eric");
  });

  test("aceita o grupo dentro de data.Groups[0]", () => {
    const res = parseGroupInfoResponse(true, 200, groupListFixture);
    expect(res.ok && res.group.jid).toBe(GROUP_JID);
  });

  test("corpo sem grupo nenhum é erro, não grupo vazio", () => {
    const res = parseGroupInfoResponse(true, 200, { code: 200, data: {}, success: true });
    expect(res.ok).toBe(false);
  });
});

describe("parseGroupInfoStruct", () => {
  test("recusa doc sem JID de grupo", () => {
    expect(parseGroupInfoStruct({ Name: "x" })).toBeNull();
    expect(parseGroupInfoStruct({ JID: "558181392929@s.whatsapp.net" })).toBeNull();
    expect(parseGroupInfoStruct(null)).toBeNull();
  });

  test("grupo sem nome cai para o JID (nunca string vazia na lista)", () => {
    const g = parseGroupInfoStruct({ JID: GROUP_JID, Participants: [] });
    expect(g?.subject).toBe(GROUP_JID);
    expect(g?.participantsCount).toBe(0);
  });
});

describe("parseUserLidResponse / parseGroupAckResponse", () => {
  test("lê o LID de {data:{jid,lid}} (formato medido)", () => {
    const res = parseUserLidResponse(true, 200, {
      code: 200,
      data: { jid: "558192985729@s.whatsapp.net", lid: OUR_LID },
      success: true,
    });
    expect(res).toEqual({ ok: true, lid: OUR_LID });
  });

  test("sem LID no corpo é falha explícita", () => {
    expect(parseUserLidResponse(true, 200, { data: {} }).ok).toBe(false);
  });

  test("ack aceita 200 sem corpo e recusa success:false", () => {
    expect(parseGroupAckResponse(true, 200, {})).toEqual({ ok: true });
    const bad = parseGroupAckResponse(true, 200, { success: false, error: "not in group" });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toBe("not in group");
  });
});

describe("inviteCodeFromLink", () => {
  test("extrai o código do link do WhatsApp", () => {
    expect(inviteCodeFromLink("https://chat.whatsapp.com/AbCdEf123456")).toBe("AbCdEf123456");
    expect(inviteCodeFromLink("  https://chat.whatsapp.com/invite/AbCdEf123456  ")).toBe(
      "AbCdEf123456"
    );
  });

  test("aceita o código solto", () => {
    expect(inviteCodeFromLink("AbCdEf123456")).toBe("AbCdEf123456");
  });

  test("recusa lixo", () => {
    expect(inviteCodeFromLink("")).toBeNull();
    expect(inviteCodeFromLink("não é link")).toBeNull();
    expect(inviteCodeFromLink("https://example.com/AbCdEf123456")).toBeNull();
  });
});

describe("weAreAdminOf", () => {
  const group = parseGroupListResponse(true, 200, groupListFixture);
  const participants = group.ok ? group.groups[0].participants : [];

  test("pelo NOSSO LID (a fonte confiável — /session/status devolve jid vazio)", () => {
    expect(weAreAdminOf({ participants }, OUR_LID, undefined)).toEqual({
      weAreAdmin: false,
      weAreSuperAdmin: false,
    });
    expect(weAreAdminOf({ participants }, ADMIN_LID, undefined)).toEqual({
      weAreAdmin: true,
      weAreSuperAdmin: true,
    });
  });

  test("cai para o telefone quando o LID não é conhecido (self-hosted)", () => {
    expect(weAreAdminOf({ participants }, undefined, "558181392929").weAreAdmin).toBe(true);
  });

  test("sem LID nem telefone não chuta admin", () => {
    expect(weAreAdminOf({ participants }, undefined, undefined).weAreAdmin).toBe(false);
  });
});

describe("request builders", () => {
  test("list e info usam GET com o token de instância", () => {
    expect(buildGroupListRequest({ baseUrl: BASE, token: TOKEN })).toEqual({
      method: "GET",
      url: `${BASE}/group/list`,
      headers: { token: TOKEN },
    });
    const info = buildGroupInfoRequest({ baseUrl: BASE, token: TOKEN, groupJid: GROUP_JID });
    expect(info.url).toBe(`${BASE}/group/info?groupJID=${encodeURIComponent(GROUP_JID)}`);
  });

  test("leave manda GroupJID no corpo", () => {
    const req = buildGroupLeaveRequest({ baseUrl: `${BASE}/`, token: TOKEN, groupJid: GROUP_JID });
    expect(req.url).toBe(`${BASE}/group/leave`);
    expect(JSON.parse(req.body!)).toEqual({ GroupJID: GROUP_JID });
  });

  test("inviteinfo e join mandam Code", () => {
    expect(JSON.parse(buildGroupInviteInfoRequest({ baseUrl: BASE, token: TOKEN, code: "X1" }).body!)).toEqual({
      Code: "X1",
    });
    expect(JSON.parse(buildGroupJoinRequest({ baseUrl: BASE, token: TOKEN, code: "X1" }).body!)).toEqual({
      Code: "X1",
    });
  });

  test("user/lid é GET com o telefone no caminho", () => {
    const req = buildUserLidRequest({ baseUrl: BASE, token: TOKEN, phone: "558192985729" });
    expect(req.url).toBe(`${BASE}/user/lid/558192985729`);
  });
});
