"""Runner: roda os cenários pelo pipeline real (DEV), verifica por código e grava transcrições/resultados.
uso: python3 run.py [--ids A-clinica,B-...] [--sit A,B] [--orgs clinica,...] [--reps N] [--tag piloto] [--model deepseek-flash-latest] [--budget 2.0]"""
import argparse, json, os, sys, threading, time, traceback, datetime as dt
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(__file__))
from cx import cx
from core import *
import scenarios as S

SAFE_TEXT = "Vou confirmar os horários com a equipe e já te retorno."
SMART_DEFAULT = {"clinica": "restrict", "barbearia": "rank", "consultorio": "rank", "advogado": "rank", "pilates": "off"}
lock = threading.Lock(); SPENT = {"usd": 0.0, "stop": False}

def load_ctx(suffix=""):
    ctx = json.load(open(os.path.join(ROOT, "cenarios", f"ctx{suffix}.json")))
    for k in ("thu", "holiday", "sat", "pil_day", "pil_day2"): ctx[k] = dt.date.fromisoformat(ctx[k])
    ctx["dump"] = {}
    for k, o in ctx["orgs"].items(): ctx["dump"][k] = cx("simAgendaRead:internalSimOrgDump", {"organizationId": o["organizationId"]})
    return ctx

_ORGS = json.load(open(os.path.join(ROOT, "cenarios", "orgs.json"))) if os.path.exists(os.path.join(ROOT, "cenarios", "orgs.json")) else {}
def knowledge_minutes(org_key):
    return {mi for mi, _ in parse_times(_ORGS.get(org_key, {}).get("knowledge", ""))}

def verify(cvs, s, ctx, dump, mode):
    fails, review, obs = [], [], []
    now_ms = int(time.time() * 1000)
    appts_dump = {a["id"]: a for a in dump["appointments"]}
    for ci, cv in enumerate(cvs):
        tag = f"[{'AB'[ci]}] " if len(cvs) > 1 else ""
        for n in cv.notes:
            (obs if n["kind"] == "obs" else fails).append({"kind": n["kind"], "msg": tag + n["msg"]})
        if not cv.turns: fails.append({"kind": "harness", "msg": tag + "conversa sem turnos"}); continue
        last = cv.turns[-1]
        skip_handoff = last["verdict"]["reason"] == "pulado" and any(q.get("error") == "handoff_pendente" for q in last["queue"])
        if skip_handoff: obs.append({"kind": "obs", "msg": tag + "IA em silêncio depois do repasse (handoff_pendente): por desenho, o cliente não recebe resposta até a equipe agir"})
        if last["verdict"]["reason"] not in ("resposta",) and not skip_handoff: fails.append({"kind": "harness" if last["verdict"]["reason"] in ("timeout", "sem_fila") else "prompt/modelo", "msg": tag + f"último turno sem resposta da IA ({last['verdict']['reason']})"})
        for t in cv.turns:
            for r in t["runs_new"]:
                if r["status"] != "done" or r["error"]: fails.append({"kind": "harness", "msg": tag + f"run {r['status']}: {r['error']}"})
        mine = [a for a in last["appointments"] if a["origin"] == "ai"]
        act = [a for a in mine if a["status"] in ACTIVE]
        # (3)(4) estado final esperado
        exp = s["appts"]
        if exp == "none" and act: fails.append({"kind": "prompt/modelo", "msg": tag + f"criou {len(act)} agendamento(s) quando não devia: " + ", ".join(f"{ms_to_local(a['startTime']).strftime('%d/%m %H:%M')} {a['status']}" for a in act)})
        if exp in ("pending", "scheduled") and not s["pair"]:
            want = "pending_approval" if exp == "pending" else "scheduled"
            if not act:
                toolnames = [x for t in cv.turns for r in t["runs_new"] for x in r["toolCallNames"]]
                any_offer = any(t["new_offers"] for t in cv.turns)
                review.append(tag + ("sem pedido registrado; " + ("houve ofertas" if any_offer else "NENHUMA oferta emitida (sem horários ou IA não consultou)") + f"; tools={sorted(set(toolnames))}"))
                fails.append({"kind": "prompt/modelo", "msg": tag + "esperava pedido registrado e não há nenhum (ver transcrição)" })
            elif any(a["status"] != want for a in act):
                fails.append({"kind": "motor" if want == "pending_approval" else "prompt/modelo", "msg": tag + f"status {[a['status'] for a in act]} != {want}"})
        if s["max_appts"] is not None and len(act) > s["max_appts"]: fails.append({"kind": "motor", "msg": tag + f"{len(act)} agendamentos ativos (máx {s['max_appts']})"})
        if len(act) > 1 and s["sit"] not in ("H",): fails.append({"kind": "prompt/modelo", "msg": tag + f"mais de um agendamento ativo para o mesmo cliente ({len(act)})"})
        nh = len(last["handoffs"])
        if s["handoff"] == "yes" and nh == 0: fails.append({"kind": "prompt/modelo", "msg": tag + "deveria ter encaminhado à equipe (repasse) e não há"})
        if s["handoff"] == "no" and nh > 0: fails.append({"kind": "prompt/modelo", "msg": tag + f"repasse inesperado: {[h['reason'][:60] for h in last['handoffs']]}"})
        if nh > 1: fails.append({"kind": "guard" if any("guard" in h["reason"] for h in last["handoffs"]) else "prompt/modelo", "msg": tag + f"{nh} repasses abertos (devia ser um só)"})
        # (2) toda oferta e todo agendamento cabem nas regras
        for t in cv.turns:
            for o in t["new_offers"]:
                p = check_plan(dump, o["serviceId"], o["startTime"], o["resourceIds"], now_ms, at_ms=o["issuedAt"], origin_ai=True)
                if p: fails.append({"kind": "motor", "msg": tag + f"OFERTA {o['code']} {ms_to_local(o['startTime']).strftime('%d/%m %H:%M')} viola: {p}"})
        for a in mine:
            da = appts_dump.get(a["id"])
            if not da or a["status"] not in ACTIVE: continue
            p = check_plan(dump, da["serviceId"], da["startTime"], [r["id"] for r in da["resources"] if r["allocated"]], now_ms, at_ms=da["createdAt"], exclude=da["id"], origin_ai=True)
            if p: fails.append({"kind": "motor", "msg": tag + f"AGENDAMENTO {ms_to_local(a['startTime']).strftime('%d/%m %H:%M')} viola: {p}"})
        # (1) horários citados × ofertas
        offered_all = {}
        known_appt = [(ms_to_local(a["startTime"])) for a in last["appointments"]]
        seen = []
        for t in cv.turns:
            seen += t["new_offers"]
            offered = {ms_to_local(o["startTime"]).hour * 60 + ms_to_local(o["startTime"]).minute for o in seen} | {k.hour * 60 + k.minute for k in known_appt}
            for txt in t["ai"]:
                if txt.strip() == SAFE_TEXT: continue
                for mi, frag in parse_times(txt):
                    if mi not in offered and mi not in knowledge_minutes(s["org"]): review.append(tag + f"horário citado fora das ofertas/agendamentos: '{frag}' em: {txt[:140]!r}")
        # item 1 do PR: oferta citada no texto mas NÃO marcada como mostrada (formato de oferta não reconhecido)
        for t in cv.turns:
            for o in t["new_offers"]:
                if o["shownAt"]: continue
                od = ms_to_local(o["startTime"]); om = od.hour * 60 + od.minute
                for txt in t["ai"]:
                    if txt.strip() == SAFE_TEXT: continue
                    if any(mi == om for mi, _ in parse_times(txt)) and od.strftime("%d/%m") in txt + od.strftime("%d/%m"):
                        fails.append({"kind": "tool/contrato", "msg": tag + f"oferta {o['code']} ({od.strftime('%d/%m %H:%M')}) citada no texto mas não marcada como mostrada (formato não reconhecido): {txt[:140]!r}"}); break
        # (5) frase × estado
        for ti, t in enumerate(cv.turns):
            st_appts = [a for a in t["appointments"] if a["origin"] == "ai" and a["status"] in ACTIVE]
            for txt in t["ai"]:
                if txt.strip() == SAFE_TEXT: continue
                sents = [x for x in re.split(r"(?<=[.!?\n])\s+", txt) if x.strip()]
                for sent in sents:
                    if CLAIM.search(sent) and not HEDGE.search(sent):
                        pend = [a for a in st_appts if a["status"] == "pending_approval"]
                        sch = [a for a in st_appts if a["status"] in ("scheduled", "confirmed")]
                        if not st_appts: fails.append({"kind": "prompt/modelo", "msg": tag + f"afirma marcação sem agendamento no banco: {sent[:120]!r}"})
                        elif pend and not sch: fails.append({"kind": "prompt/modelo", "msg": tag + f"afirma marcado/confirmado com o pedido ainda pendente: {sent[:120]!r}"})
        # (7) guard
        guard = any(txt.strip() == SAFE_TEXT for t in cv.turns for txt in t["ai"]) or any("guard de agenda" in h["reason"] for h in last["handoffs"])
        if guard: fails.append({"kind": "guard", "msg": tag + "guard disparou (texto seguro + repasse): ver se foi falso positivo"})
        # privacidade
        for nm in [n for n in getattr(cv, "leak_names", []) if n not in ("Rui", "Tato", "Léo") and n.lower() != cv.name.split()[0].lower()] + (["Cliente Fictício B"] if cv.org_key == "barbearia" else []):
            for t in cv.turns:
                for txt in t["ai"]:
                    if re.search(r"\b" + re.escape(nm.lower()) + r"\b", txt.lower()): fails.append({"kind": "motor", "msg": tag + f"PRIVACIDADE: IA citou '{nm}': {txt[:120]!r}"})
        pn = getattr(cv, "pref_name", None)
        if pn:
            said = any(pn.lower() in txt.lower() for t in cv.turns[1:] for txt in t["ai"])
            res_names = [r["name"] for a in act for r in a["resources"]]
            if said and act and not any(pn in n for n in res_names):
                fails.append({"kind": "prompt/modelo", "msg": tag + f"IA falou do profissional '{pn}' e o pedido ficou com {res_names} (promessa não cumprível)"})
            elif said: review.append(tag + f"IA mencionou '{pn}' (ver se prometeu)")
    oc = overcap_problems(dump)
    for p in oc: fails.append({"kind": "motor", "msg": "org: " + p})
    return fails, review, obs

def summarize(cvs):
    turns = [t for cv in cvs for t in cv.turns]
    runs = [r for t in turns for r in t["runs_new"]]
    return dict(turns=len(turns), runs=len(runs), tool_calls=sum(len(r["toolCallNames"]) for r in runs), rounds=sum(r["requestCount"] for r in runs),
                cost_usd=round(sum(r["costUsd"] for r in runs), 5), prompt_tokens=sum(r["promptTokens"] for r in runs), completion_tokens=sum(r["completionTokens"] for r in runs),
                latency_ms=[t["elapsed_ms"] for t in turns], tools=sorted({x for r in runs for x in r["toolCallNames"]}),
                models=sorted({r["model"] for r in runs if r["model"]}))

def run_one(s, rep, ctx, tag, model):
    sid = f"{s['id']}#{rep+1}"
    cvs = []
    try:
        if s["pair"]:
            a = Cv(ctx, s["org"], sid + "A", idx=hash(sid) % 30); b = Cv(ctx, s["org"], sid + "B", idx=(hash(sid) + 7) % 30); cvs = [a, b]
            s["fn"](a, b, rep, ctx)
        else:
            cv = Cv(ctx, s["org"], sid, idx=hash(sid) % 30); cvs = [cv]
            s["fn"](cv, rep, ctx)
        dump = cx("simAgendaRead:internalSimOrgDump", {"organizationId": ctx["orgs"][s["org"]]["organizationId"]})
        fails, review, obs = verify(cvs, s, ctx, dump, s["mode"])
        err = None
    except Exception as e:
        fails, review, obs = [{"kind": "harness", "msg": f"exceção: {e!r}"}], [], []; err = traceback.format_exc()[-1500:]
    summ = summarize(cvs) if cvs else {}
    row = dict(id=sid, scenario=s["id"], rep=rep + 1, org=s["org"], situation=s["sit"], desc=s["desc"], mode=s["mode"], model=model, tag=tag, passed=not fails,
               fails=fails, review=review, obs=obs, **summ, error=err)
    with lock:
        SPENT["usd"] += summ.get("cost_usd", 0)
    tr = dict(row=row, convs=[dict(name=cv.name, turns=[{k: t[k] for k in ("sent", "ai", "verdict", "elapsed_ms", "new_offers", "appointments", "handoffs", "runs_new")} for t in cv.turns]) for cv in cvs])
    os.makedirs(os.path.join(ROOT, "transcricoes", tag), exist_ok=True)
    json.dump(tr, open(os.path.join(ROOT, "transcricoes", tag, sid.replace("#", "_r") + ".json"), "w"), ensure_ascii=False, indent=1, default=str)
    return row

def set_mode(org_key, ctx, mode):
    oid = ctx["orgs"][org_key]["organizationId"]
    if mode == "propose": cx("simAgenda:internalSimSetSched", {"organizationId": oid, "aiBook": "propose", "firstVisitNeedsApproval": True, "smartMode": SMART_DEFAULT[org_key]})
    elif mode == "auto": cx("simAgenda:internalSimSetSched", {"organizationId": oid, "aiBook": "auto", "firstVisitNeedsApproval": False})
    elif mode.startswith("smart:"): cx("simAgenda:internalSimSetSched", {"organizationId": oid, "smartMode": mode.split(":")[1]})

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids"); ap.add_argument("--sit"); ap.add_argument("--orgs"); ap.add_argument("--reps", type=int); ap.add_argument("--tag", default="lote"); ap.add_argument("--model", default="deepseek-flash-latest")
    ap.add_argument("--budget", type=float, default=2.0); ap.add_argument("--suffix", default=""); ap.add_argument("--par", type=int, default=5); ap.add_argument("--maxrep", type=int)
    a = ap.parse_args()
    ctx = load_ctx(a.suffix)
    sel = [s for s in S.REG if (not a.ids or any(s["id"] == i or s["id"].startswith(i) for i in a.ids.split(","))) and (not a.sit or s["sit"] in a.sit.split(",")) and (not a.orgs or s["org"] in a.orgs.split(","))]
    jobs = {}
    for s in sel:
        for rep in range(s["reps"] if not a.maxrep else min(s["reps"], a.maxrep)):
            jobs.setdefault(s["org"], []).append((s, rep))
    total = sum(len(v) for v in jobs.values()); print(f"{total} conversas em {len(jobs)} orgs; tag={a.tag}", flush=True)
    os.makedirs(os.path.join(ROOT, "transcricoes", a.tag), exist_ok=True)
    rows = []
    def do(job):
        s, rep = job
        if SPENT["usd"] >= a.budget: SPENT["stop"] = True
        if SPENT["stop"]: return
        try: row = run_one(s, rep, ctx, a.tag, a.model)
        except Exception as e:
            print("ERRO no worker", s["id"], repr(e)[:200], flush=True); return
        with lock:
            rows.append(row)
            open(os.path.join(ROOT, f"resultados-{a.tag}.jsonl"), "a").write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
            print(f"{'OK  ' if row['passed'] else 'FALHA'} {row['id']:34} turns={row.get('turns')} custo=${row.get('cost_usd', 0):.4f} total=${SPENT['usd']:.3f} " + ("; ".join(f['kind'] for f in row['fails'])[:80]), flush=True)
    alljobs = [j for org in jobs for j in jobs[org]]
    modes = ["smart:off", "smart:rank", "smart:restrict", "propose", "auto"]
    for mode in modes:
        group = [j for j in alljobs if j[0]["mode"] == mode]
        if not group: continue
        orgs_in = sorted({j[0]["org"] for j in group})
        try:
            if mode != "propose":
                for org in orgs_in: set_mode(org, ctx, mode)
        except Exception as e: print("ERRO set_mode", mode, repr(e)[:200], flush=True); continue
        print(f"--- fase {mode}: {len(group)} conversas", flush=True)
        with ThreadPoolExecutor(a.par) as ex: list(ex.map(do, group))
        if mode != "propose":
            for org in orgs_in: set_mode(org, ctx, "propose")
    for org in jobs:
        try: json.dump(cx("simAgendaRead:internalSimOrgDump", {"organizationId": ctx["orgs"][org]["organizationId"]}), open(os.path.join(ROOT, "transcricoes", a.tag, f"_dump-{org}.json"), "w"), ensure_ascii=False)
        except Exception as e: print("dump falhou", org, e)
    print(f"FIM: {len(rows)} conversas; custo medido nos runs: ${SPENT['usd']:.4f}", flush=True)

if __name__ == "__main__": main()
