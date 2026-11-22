"""Bloco D: Copiloto pelas funções internas que a tela usa (leitura/escrita em duas fases + confirmar), sem modelo (custo zero)."""
import json, os, sys, time, datetime as dt
sys.path.insert(0, os.path.dirname(__file__))
from cx import cx
from core import *
import run as R
log = []
def rec(name, **kw): log.append(dict(step=name, **kw)); print(name, json.dumps(kw, ensure_ascii=False)[:420], flush=True)
def main(suffix="-r3"):
    ctx = R.load_ctx(suffix); o = ctx["orgs"]["clinica"]; oid = o["organizationId"]; admin = o["adminMemberId"]
    viewer = cx("simAgenda:internalSimAddMember", {"organizationId": oid, "name": "Leitora Geral", "agenda": "view_all"})
    thr = cx("copilot:internalGetOrCreateThread", {"organizationId": oid, "memberId": admin})
    vthr = cx("copilot:internalGetOrCreateThread", {"organizationId": oid, "memberId": viewer})
    def rd(name, args, member=admin, th=thr): return cx("copilot:internalRunCopilotReadTool", {"name": name, "argsJson": json.dumps(args, ensure_ascii=False), "organizationId": oid, "memberId": member, "now": int(time.time() * 1000), "threadId": th, "turnStartedAt": int(time.time() * 1000)})
    def wr(name, args, member=admin, th=thr): return cx("copilot:internalRunCopilotWriteTool", {"name": name, "argsJson": json.dumps(args, ensure_ascii=False), "organizationId": oid, "memberId": member, "threadId": th})
    def dump(): return cx("simAgendaRead:internalSimOrgDump", {"organizationId": oid})
    def active(d): return [a for a in d["appointments"] if a["status"] in ACTIVE]
    tue = (today() + dt.timedelta(days=1)); 
    while tue.weekday() != 1: tue += dt.timedelta(days=1)
    wed = tue + dt.timedelta(days=1)
    # leituras
    for step, name, args in [("D1 o que tenho hoje", "getAgendaDay", {"date": "hoje"}), ("D2 amanhã", "getAgendaDay", {"date": "amanha"}), ("D3 pendências", "listAgendaPending", {}),
                             ("D4 tem buraco amanhã", "findAgendaGaps", {"date": "amanha"}), ("D5 horários livres", "findFreeTimes", {"serviceName": "Massoterapia", "date": tue.isoformat(), "period": "tarde"})]:
        r = rd(name, args); rec(step, ok=("error" not in r), keys=list(r)[:6] if isinstance(r, dict) else type(r).__name__, sample=json.dumps(r, ensure_ascii=False)[:300])
    maria = cx("simAgenda:internalSimNewCustomer", {"organizationId": oid, "name": "Maria", "phone": "5599910000001"})
    j1 = cx("simAgenda:internalSimNewCustomer", {"organizationId": oid, "name": "João Silva", "phone": "5599910000002"})
    j2 = cx("simAgenda:internalSimNewCustomer", {"organizationId": oid, "name": "João Souza", "phone": "5599910000003"})
    # D6 marcar com prévia, sem confirmar nada é gravado
    n0 = len(active(dump()))
    r = wr("bookAppointment", {"contactId": maria["contactId"], "serviceName": "Massoterapia", "startLocal": f"{tue.isoformat()}T16:00", "resourceName": "Sala 1"})
    n1 = len(active(dump())); pid = (r.get("pendingActionId") or r.get("pendingId") or (r.get("confirmacao_necessaria") or {}).get("id")) if isinstance(r, dict) else None
    rec("D6 marca a Maria (prévia)", result_keys=list(r)[:8], preview=json.dumps(r, ensure_ascii=False)[:420], gravou_antes_de_confirmar=(n1 - n0), pending=pid)
    # D7 confirmar por membro que não é o dono da ação deve recusar
    try:
        cx("copilot:internalConfirmPendingAction", {"pendingActionId": pid, "memberId": viewer}, retries=0); rec("D7 outro membro confirma a ação da prévia", recusou=False)
    except Exception as e: rec("D7 outro membro confirma a ação da prévia", recusou=True, erro=str(e)[-160:])
    n2 = len(active(dump()))
    c = cx("copilot:internalConfirmPendingAction", {"pendingActionId": pid, "memberId": admin}); d = dump(); na = [a for a in active(d) if a["contactName"] and "Maria" in a["contactName"]]
    rec("D8 confirma a Maria", resposta=json.dumps(c, ensure_ascii=False)[:200], gravado=[(ms_to_local(a["startTime"]).strftime("%a %d/%m %H:%M"), [r["name"] for r in a["resources"]], a["status"], a["origin"]) for a in na], igual_a_previa=bool(na and ms_to_local(na[0]["startTime"]).strftime("%H:%M") == "16:00" and [r["name"] for r in na[0]["resources"] if r["name"].startswith("Sala")] == ["Sala 1"]), novos_entre_D7_e_D8=len(active(d)) - n2)
    # João Silva: marcar e remarcar
    r = wr("bookAppointment", {"contactId": j1["contactId"], "serviceName": "Massoterapia", "startLocal": f"{tue.isoformat()}T14:00"}); pid2 = r.get("pendingActionId") if isinstance(r, dict) else None
    if pid2: cx("copilot:internalConfirmPendingAction", {"pendingActionId": pid2, "memberId": admin})
    day = rd("getAgendaDay", {"date": tue.isoformat()}); txt = json.dumps(day, ensure_ascii=False)
    import re as _re
    refj = None
    for it in (day.get("itens") or []) if isinstance(day, dict) else []:
        if "João Silva" in json.dumps(it, ensure_ascii=False): refj = it.get("ref")
    rec("D9 João marcado e ref", ref=refj, day_keys=list(day)[:8] if isinstance(day, dict) else None)
    if refj:
        r = wr("rescheduleAppointment", {"ref": refj, "startLocal": f"{wed.isoformat()}T14:00"}); pid3 = r.get("pendingActionId")
        antes = [(ms_to_local(a["startTime"]).strftime("%d/%m %H:%M")) for a in active(dump()) if a["contactName"] and "João Silva" in a["contactName"]]
        rec("D10 remarca o João (prévia)", preview=json.dumps(r, ensure_ascii=False)[:350], horario_antes_de_confirmar=antes)
        if pid3:
            cx("copilot:internalConfirmPendingAction", {"pendingActionId": pid3, "memberId": admin})
            depois = [(ms_to_local(a["startTime"]).strftime("%d/%m %H:%M"), a["status"]) for a in dump()["appointments"] if a["contactName"] and "João Silva" in a["contactName"]]
            rec("D11 confirma a remarcação", agendamentos_do_joao=depois)
    # cancelar "o das 15h" (segunda, seed)
    mon = today() + dt.timedelta(days=1)
    while mon.weekday() != 0: mon += dt.timedelta(days=1)
    day = rd("getAgendaDay", {"date": mon.isoformat()}); refc = None
    for it in (day.get("itens") or []) if isinstance(day, dict) else []:
        if "15:00" in json.dumps(it, ensure_ascii=False): refc = it.get("ref")
    if refc:
        r = wr("cancelAppointment", {"ref": refc, "reason": "teste"}); pid4 = r.get("pendingActionId")
        before = [a["status"] for a in dump()["appointments"] if a["id"] and ms_to_local(a["startTime"]).strftime("%d/%m %H:%M") == mon.strftime("%d/%m") + " 15:00"]
        rec("D12 cancela o das 15h (prévia)", preview=json.dumps(r, ensure_ascii=False)[:300], status_antes_de_confirmar=before)
        if pid4:
            cx("copilot:internalConfirmPendingAction", {"pendingActionId": pid4, "memberId": admin})
            after = [a["status"] for a in dump()["appointments"] if ms_to_local(a["startTime"]).strftime("%d/%m %H:%M") == mon.strftime("%d/%m") + " 15:00"]
            rec("D13 confirma cancelamento", status_depois=after)
    # fechar a sala 2 amanhã (prévia mostra impacto; nada confirmado)
    ex0 = len(dump()["exceptions"]); r = wr("closeResourceDay", {"resourceName": "Sala 2", "date": mon.isoformat()}); ex1 = len(dump()["exceptions"])
    rec("D14 fecha a sala 2 (prévia)", preview=json.dumps(r, ensure_ascii=False)[:500], excecoes_gravadas_sem_confirmar=ex1 - ex0)
    # ambíguo: dois Joãos
    r = rd("searchContacts", {"query": "João"}); rec("D15 ambíguo: busca 'João'", candidatos=json.dumps(r, ensure_ascii=False)[:300])
    # permissão view_all
    for step, name, args in [("D16 view_all lê o dia", "getAgendaDay", {"date": "amanha"})]:
        r = rd(name, args, member=viewer, th=vthr); rec(step, ok=("error" not in r))
    try:
        r = wr("bookAppointment", {"contactId": maria["contactId"], "serviceName": "Massoterapia", "startLocal": f"{wed.isoformat()}T10:00"}, member=viewer, th=vthr); rec("D17 view_all tenta marcar", recusou=("error" in r) if isinstance(r, dict) else False, resposta=json.dumps(r, ensure_ascii=False)[:200])
    except Exception as e: rec("D17 view_all tenta marcar", recusou=True, erro=str(e)[-200:])
    json.dump(log, open(os.path.join(ROOT, "resultados-d1.json"), "w"), ensure_ascii=False, indent=1)
if __name__ == "__main__": main()
