"""Bloco E: C1 ao vivo (modo auto com janela de 60 s). Espera real (75 s) onde o caso pede. Humano pelo gancho do aparelho."""
import json, os, sys, time, uuid, datetime as dt, threading
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(__file__))
from cx import cx
from core import *
import run as R
from c1 import nd
def cases(org):
    tue, wed, mon = nd(1), nd(2), nd(0); tom = today() + dt.timedelta(days=1)
    who = {"clinica": "a Ana", "barbearia": "o Rui", "consultorio": "a Dra. Helena"}[org]
    T = lambda d, h, m=0: local_to_ms(d, h * 60 + m)
    # (id, esperado, [cliente], [(humano, espera_depois_s)], horário esperado)
    return [
      ("P1", "create", ["quero marcar terça às 10h"], [("Confirmado terça 10h", 0)], T(tue, 10)),
      ("P2", "create", ["queria agendar amanhã às 15h"], [("Pode vir amanhã às 15h", 0)], T(tom, 15)),
      ("P3", "create", [f"quero horário quarta às 9h com {who}"], [(f"Fechado, quarta 9h com {who}", 0)], T(wed, 9)),
      ("P4", "create", ["quero ir segunda às 14h, pode?"], [("ok", 0)], T(mon, 14)),
      ("C-dentro", "none", ["quero marcar terça às 11h"], [("Confirmado terça 11h", 5), ("ops, terça 14h", 0)], None),
      ("C-fora", "undone", ["quero marcar terça às 11h"], [("Confirmado terça 11h", 75), ("ops, terça 14h", 0)], None),
      ("Terceiro", "third", ["quero marcar terça às 10h pro meu marido"], [("Confirmado terça 10h", 0)], None),
      ("Funcionamento", "none", ["Vocês abrem segunda às 10h?"], [("Confirmado segunda 10h", 0)], None),
      ("Pagamento", "none", ["fiz o pix agora às 10h"], [("confirmado o pix", 0)], None),
      ("Desconsidera", "undone", ["quero marcar terça às 10h"], [("Confirmado terça 10h", 75), ("desconsidera, conversa errada", 0)], None),
    ]
def run_case(ctx, org, case, i):
    cid, exp, cl, hu, start = case; o = ctx["orgs"][org]; oid = o["organizationId"]
    c = cx("simAgenda:internalSimNewCustomer", {"organizationId": oid, "name": NAMES[(i * 3 + 7) % 30], "phone": f"55977{abs(hash((org, cid))) % 10**7:07d}"})
    t0 = int(time.time() * 1000)
    for m in cl:
        cx("conversations:internalReceiveMessage", {"organizationId": oid, "leadId": c["leadId"], "channel": "whatsapp", "channelConfigId": c["channelConfigId"], "content": m, "skipAiEnqueue": True}); time.sleep(1.2)
    for m, wait in hu:
        cx("conversations:internalReceiveDeviceMessage", {"organizationId": oid, "leadId": c["leadId"], "channel": "whatsapp", "channelConfigId": c["channelConfigId"], "content": m, "externalId": "sim-" + uuid.uuid4().hex}); time.sleep(max(wait, 2))
    waited = 75 if exp in ("create",) else 12
    time.sleep(waited)
    for _ in range(6):
        st = cx("simAgendaRead:internalSimState", {"organizationId": oid, "conversationId": c["conversationId"]})
        interp = cx("simAgendaRead:internalSimInterpretations", {"organizationId": oid, "conversationId": c["conversationId"], "sinceMs": t0})
        if all(r["status"] != "pending" and r["decision"] != "pending" for r in interp["rows"]): break
        time.sleep(8)
    allappts = [a for a in st["appointments"] if a["origin"] != "ai"]
    act = [a for a in allappts if a["status"] in ACTIVE]; canc = [a for a in allappts if a["status"] == "cancelled"]
    open_sugg = [r for r in interp["rows"] if r["decision"] == "proposed" and r["status"] == "open"]
    labels = [r["reason"] for r in interp["rows"]]
    if exp == "create": out = "criou certo" if [a for a in act if abs(a["startTime"] - start) < 60000] and len(act) == 1 else ("criou ERRADO" if act else ("sugeriu (conservador)" if open_sugg else "nada"))
    elif exp == "undone": out = "criou e desfez (certo)" if canc and not act else ("NÃO desfez" if act else ("nunca criou" if not canc else "?"))
    elif exp == "third": out = "sugestão rotulada (certo)" if open_sugg and not act and any(l and "outra" in l for l in labels) else ("criou INDEVIDO" if act else ("sugeriu sem rótulo" if open_sugg else "quieto"))
    else: out = "CRIOU INDEVIDO" if act else ("sugeriu INDEVIDO" if open_sugg else "quieto (certo)")
    return dict(org=org, case=cid, expected=exp, outcome=out, decisions=[(r["decision"], r["status"], r["reason"], r["act"]) for r in interp["rows"]], created=[(ms_to_local(a["startTime"]).strftime("%a %d/%m %H:%M"), a["status"]) for a in allappts],
                llm_calls=len(interp["runs"]), cost_usd=sum(r["costUsd"] for r in interp["runs"]), lat_ms=[r["startedAt"] for r in interp["runs"]])
def main():
    ctx = R.load_ctx("-r4"); rows = []; lock = threading.Lock(); out = open(os.path.join(ROOT, "resultados-E.jsonl"), "a")
    for org in ("clinica", "barbearia", "consultorio"):
        o = ctx["orgs"][org]; svc = {"clinica": "Massoterapia", "barbearia": "Corte", "consultorio": "Avaliação"}[org]
        cx("simAgenda:internalSimSetSched", {"organizationId": o["organizationId"], "humanConfirmMode": "auto", "defaultService": svc})
    jobs = [(ctx, org, case, i) for org in ("clinica", "barbearia", "consultorio") for i, case in enumerate(cases(org))]
    def w(j):
        try: r = run_case(*j)
        except Exception as e: r = dict(org=j[1], case=j[2][0], outcome="harness: " + repr(e)[:150], cost_usd=0)
        with lock: rows.append(r); out.write(json.dumps(r, ensure_ascii=False) + "\n"); out.flush(); print(r["org"], r["case"], r["outcome"], flush=True)
    with ThreadPoolExecutor(10) as ex: list(ex.map(w, jobs))
    for org in ("clinica", "barbearia", "consultorio"): cx("simAgenda:internalSimSetSched", {"organizationId": ctx["orgs"][org]["organizationId"], "humanConfirmMode": "suggest"})
    print("custo classificador", round(sum(r.get("cost_usd", 0) for r in rows), 5), "msgs", len(rows))
if __name__ == "__main__": main()
