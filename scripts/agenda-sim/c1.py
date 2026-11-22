"""Bloco C: confirmação pelo WhatsApp (C1). O cliente fala pela entrada real SEM acordar o atendente (skipAiEnqueue); o HUMANO responde pelo
caminho 'mensagem do aparelho' (internalReceiveDeviceMessage, mesmo gancho do celular pareado; demoMode: nada sai). Mede o que a interpretação fez."""
import json, os, sys, time, uuid, re, datetime as dt, threading
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(__file__))
from cx import cx
from core import *
import run as R

def nd(wd, mind=1):
    d = today() + dt.timedelta(days=mind)
    while d.weekday() != wd: d += dt.timedelta(days=1)
    return d
WDN = {0: "segunda", 1: "terça", 2: "quarta", 3: "quinta", 4: "sexta", 5: "sábado"}
def mk_cases(org):
    tue, wed = nd(1), nd(2); tom = today() + dt.timedelta(days=1)
    mon = nd(0)
    who = {"clinica": "a Ana", "barbearia": "o Rui", "consultorio": "a Dra. Helena"}[org]
    T = lambda d, h, m=0: local_to_ms(d, h * 60 + m)
    # (id, expected: 'create'|'none', client msgs, human msgs, expected start or None)
    return [
      ("P1", "create", ["dá pra ser terça às 10h?"], ["Confirmado terça 10h"], T(tue, 10)),
      ("P2", "create", ["amanhã às 15h dá?"], ["Pode vir amanhã às 15h"], T(tom, 15)),
      ("P3", "create", [f"quarta às 9h com {who}?"], [f"Fechado, quarta 9h com {who}"], T(wed, 9)),
      ("P4", "create", ["posso ir segunda às 14h?"], ["ok"], T(mon, 14)),
      ("P5", "none", [], ["Confirmado quarta 11h"], None),            # humano sozinho, sem proposta do cliente: nada pode ser criado
      ("N1", "none", ["Vocês abrem segunda às 10h?"], ["Confirmado segunda 10h"], None),
      ("N2", "none", ["pode ser terça às 10h pro meu marido?"], ["Confirmado terça 10h"], None),
      ("N3", "none", ["a entrega chega amanhã às 10h?"], ["Confirmado amanhã 10h"], None),
      ("N4", "none", ["fiz o pix agora às 10h"], ["confirmado o pix"], None),
      ("N5", "none", ["quinta às 10h pode?"], ["quinta 10h não dá"], None),
      ("N6", "none", ["terça às 10h?"], ["Confirmado terça 10h", "ops, terça 11h"], None),   # correção: o 1º já pode ter criado (auto)
    ]

def mk_cases2(org):
    tue, wed, mon = nd(1), nd(2), nd(0); tom = today() + dt.timedelta(days=1)
    who = {"clinica": "a Ana", "barbearia": "o Rui", "consultorio": "a Dra. Helena"}[org]
    T = lambda d, h, m=0: local_to_ms(d, h * 60 + m)
    return [
      ("P1i", "create", ["quero marcar terça às 10h"], ["Confirmado terça 10h"], T(tue, 10)),
      ("P2i", "create", ["queria agendar amanhã às 15h"], ["Pode vir amanhã às 15h"], T(tom, 15)),
      ("P3i", "create", [f"quero horário quarta às 9h com {who}"], [f"Fechado, quarta 9h com {who}"], T(wed, 9)),
      ("P4i", "create", ["quero ir segunda às 14h, pode?"], ["ok"], T(mon, 14)),
      ("N1i", "none", ["quero saber se vocês abrem segunda às 10h"], ["Confirmado segunda 10h"], None),
      ("N2i", "none", ["quero marcar terça às 10h pro meu marido"], ["Confirmado terça 10h"], None),
      ("N3i", "none", ["quero que a entrega seja amanhã às 10h"], ["Confirmado amanhã 10h"], None),
      ("N5i", "none", ["quero marcar quinta às 10h"], ["quinta 10h não dá"], None),
      ("N6i", "none", ["quero marcar terça às 11h"], ["Confirmado terça 11h", "ops, terça 14h"], None),
    ]

def run_case(ctx, org, mode, case, i):
    cid, exp, cl, hu, start = case
    o = ctx["orgs"][org]; oid = o["organizationId"]
    c = cx("simAgenda:internalSimNewCustomer", {"organizationId": oid, "name": NAMES[(i * 3 + 5) % 30], "phone": f"55988{abs(hash((org, mode, cid))) % 10**7:07d}"})
    t0 = int(time.time() * 1000)
    for m in cl:
        cx("conversations:internalReceiveMessage", {"organizationId": oid, "leadId": c["leadId"], "channel": "whatsapp", "channelConfigId": c["channelConfigId"], "content": m, "skipAiEnqueue": True})
        time.sleep(1.2)
    for m in hu:
        cx("conversations:internalReceiveDeviceMessage", {"organizationId": oid, "leadId": c["leadId"], "channel": "whatsapp", "channelConfigId": c["channelConfigId"], "content": m, "externalId": "sim-" + uuid.uuid4().hex})
        time.sleep(1.5)
    interp = None
    for _ in range(14):
        time.sleep(3)
        interp = cx("simAgendaRead:internalSimInterpretations", {"organizationId": oid, "conversationId": c["conversationId"], "sinceMs": t0})
        rows = interp["rows"]
        if len(rows) >= len(hu) and all(r["status"] != "pending" and r["decision"] != "pending" for r in rows): break
        if not rows and _ >= 5: break      # o pré-filtro descartou (nenhuma leitura)
    time.sleep(2)
    st = cx("simAgendaRead:internalSimState", {"organizationId": oid, "conversationId": c["conversationId"]})
    interp = cx("simAgendaRead:internalSimInterpretations", {"organizationId": oid, "conversationId": c["conversationId"], "sinceMs": t0})
    appts = [a for a in st["appointments"] if a["status"] in ACTIVE]
    open_sugg = [r for r in interp["rows"] if r["decision"] == "proposed" and r["status"] == "open"]
    created = [a for a in appts if a["origin"] not in ("ai",)]
    cost = sum(r["costUsd"] for r in interp["runs"]); n_llm = len(interp["runs"])
    # leitura
    if exp == "create":
        if mode == "auto":
            ok_created = [a for a in created if abs(a["startTime"] - start) < 60000]
            outcome = "criou certo" if ok_created and len(created) == 1 else ("criou ERRADO" if created else ("sugeriu (conservador)" if open_sugg else "nada"))
        else:
            sug_ok = bool(open_sugg) and not created
            outcome = "sugeriu" if sug_ok else ("criou sem querer" if created else "nada")
    else:
        if created: outcome = "CRIOU INDEVIDO"
        elif open_sugg: outcome = "sugeriu INDEVIDO"
        else: outcome = "ficou quieto (certo)"
    row = dict(org=org, mode=mode, case=cid, expected=exp, outcome=outcome, decisions=[(r["decision"], r["status"], r["reason"], r["act"]) for r in interp["rows"]], llm_calls=n_llm, cost_usd=cost,
               created=[(ms_to_local(a["startTime"]).strftime("%a %d/%m %H:%M"), a["status"], a["origin"]) for a in created], client=cl, human=hu)
    return row

def main(tag=os.environ.get("CTAG", "c1"), suffix_pairs=(("suggest", "-r3"), ("auto", "-r3auto"))):
    out = open(os.path.join(ROOT, f"resultados-{tag}.jsonl"), "a"); rows = []; lock = threading.Lock()
    for mode, suf in suffix_pairs:
        ctx = R.load_ctx(suf)
        for org in ("clinica", "barbearia", "consultorio"):
            o = ctx["orgs"][org]
            svc = {"clinica": "Massoterapia", "barbearia": "Corte", "consultorio": "Avaliação"}[org]
            cx("simAgenda:internalSimSetSched", {"organizationId": o["organizationId"], "humanConfirmMode": "auto" if mode == "auto" else "suggest", "defaultService": svc})
        jobs = [(ctx, org, mode, case, i) for org in ("clinica", "barbearia", "consultorio") for i, case in enumerate((mk_cases2 if os.environ.get("CASESET") == "2" else mk_cases)(org))]
        def w(j):
            try: r = run_case(*j)
            except Exception as e: r = dict(org=j[1], mode=j[2], case=j[3][0], outcome="harness: " + repr(e)[:150], cost_usd=0)
            with lock:
                rows.append(r); out.write(json.dumps(r, ensure_ascii=False) + "\n"); out.flush(); print(r["mode"], r["org"], r["case"], r["outcome"], flush=True)
        with ThreadPoolExecutor(5) as ex: list(ex.map(w, jobs))
        for org in ("clinica", "barbearia", "consultorio"):   # volta ao padrão
            cx("simAgenda:internalSimSetSched", {"organizationId": ctx["orgs"][org]["organizationId"], "humanConfirmMode": "suggest"})
    print("custo classificador total", round(sum(r.get("cost_usd", 0) for r in rows), 5), "mensagens", len(rows))
if __name__ == "__main__": main()
