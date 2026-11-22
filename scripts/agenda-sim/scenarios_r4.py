"""Lote final (r4): ciclo com decisão da equipe, cancelar com horário ativo, reservado x pendente, grupo. Registra em scenarios.REG."""
import re, json as _json
from core import *
from scenarios import *
from scenarios import REG, pday, open_msg, flow_book, fix_period, SV
from scenarios_r3 import POS, NEG, ORGS5

# ═════════════════════ LOTE FINAL (r4) ═════════════════════
import json as _json, time as _time
def says_when(ai, a):
    t = ms_to_local(a["startTime"]); a_l = ai.lower()
    hour = bool(re.search(rf"\b{t.hour}\s*h(?:\s*{t.minute:02d})?\b|\b0?{t.hour}:{t.minute:02d}\b", a_l)) if t.minute == 0 else bool(re.search(rf"{t.hour}\s*h\s*{t.minute:02d}|0?{t.hour}:{t.minute:02d}", a_l))
    day = t.strftime("%d/%m") in a_l or WD[t.weekday()].split("-")[0] in a_l or "amanhã" in a_l and (t.date() - today()).days == 1
    return hour and day
CANCEL_CLAIM2 = re.compile(r"cancelei|cancelad[oa]|foi cancel|j[aá] cancel|desmarqu", re.I)
def staff_book(cv, d, hhmm):
    o = cv.o; oid = o["organizationId"]; adm = o["adminMemberId"]
    thr = cx("copilot:internalGetOrCreateThread", {"organizationId": oid, "memberId": adm})
    svc = {"clinica": "Massoterapia", "barbearia": "Corte", "consultorio": "Avaliação", "advogado": "Consulta jurídica", "pilates": "Aula de pilates"}[cv.org_key]
    r = cx("copilot:internalRunCopilotWriteTool", {"name": "bookAppointment", "argsJson": _json.dumps({"contactId": cv.c["contactId"], "serviceName": svc, "startLocal": f"{d.isoformat()}T{hhmm}"}), "organizationId": oid, "memberId": adm, "threadId": thr})
    pid = r.get("pendingActionId") if isinstance(r, dict) else None
    if not pid: return None
    cx("copilot:internalConfirmPendingAction", {"pendingActionId": pid, "memberId": adm}); return True
FIRST_HOUR = {"clinica": "09:00", "barbearia": "09:00", "consultorio": "08:00", "advogado": "14:00", "pilates": "07:00"}

def _cycle2(kind):
    def fn(cv, rep, ctx):
        d = pday(ctx, cv.org_key); cv.say(open_msg(cv, d, "de tarde")); flow_book(cv, style=rep)
        pend = [a for a in cv.appts() if a["status"] == "pending_approval"]
        if not pend: cv.flag("harness", "não conseguiu criar o pedido-base"); return
        a0 = pend[0]
        if kind == "approve": cv.decide("approve")
        elif kind == "decline": cv.decide("decline")
        else: cv.expire()
        cv.say(["e aí, confirmou?", "oi, deu certo meu horário?", "e então, tá confirmado?"][rep % 3])
        ai = cv.last_ai(); mine = [a for a in cv.turns[-1]["appointments"] if a["origin"] == "ai"]
        if kind == "approve":
            cv.expect(any(a["status"] == "scheduled" for a in mine), "motor", "aprovação não virou scheduled")
            cv.expect(bool(POS.search(ai)) and not re.search(r"aguardando|ainda n[aã]o", ai, re.I), "prompt/modelo", f"aprovado e a IA não confirmou: {ai[60:260]!r}")
            cv.expect(says_when(ai, a0), "prompt/modelo", f"confirmou sem dizer data e hora certas: {ai[60:260]!r}")
        elif kind == "decline":
            cv.expect(not (POS.search(ai) and not NEG.search(ai)), "prompt/modelo", f"recusado e a IA diz marcado: {ai[60:260]!r}")
            cv.expect(bool(re.search(r"n[aã]o (?:foi poss|deu|consegu|p[ou]d|confirm)|recus|infelizmente|indispon", ai, re.I)), "prompt/modelo", f"recusado e a IA não disse que não foi possível: {ai[60:260]!r}")
            cv.expect(bool(re.search(r"outro|consult|ver|procur|quer|posso", ai, re.I)), "prompt/modelo", "recusado e a IA não ofereceu consultar outro horário")
            cv.say("pode sim, me vê outro horário")
            cv.expect(bool([o for o in cv.turns[-1]["new_offers"] if o["shownAt"]]), "prompt/modelo", f"cliente aceitou e a IA não consultou/ofereceu de verdade: {cv.last_ai()[60:240]!r}")
        else:
            cv.expect(not (POS.search(ai) and not NEG.search(ai)), "prompt/modelo", f"venceu e a IA diz marcado: {ai[60:260]!r}")
            cv.flag("obs", "vencida: " + ai[60:240].replace("\n", " "))
    return fn
for _k in ("approve", "decline", "expire"):
    for _o in ORGS5:
        REG.append(dict(id=f"F-A-{_k}-{_o}", org=_o, sit="FA", desc=f"ciclo IA propõe -> equipe {_k}", appts="any", handoff="any", reps=3, mode="propose", pair=False, fn=_cycle2(_k), max_appts=None, tags=()))

def _meu(cv, rep, ctx):
    d = pday(ctx, cv.org_key); cv.say(open_msg(cv, d, "de tarde")); flow_book(cv, style=rep); a0 = cv.appts()
    if not a0: cv.flag("harness", "sem pedido-base"); return
    cv.say("que dia é o meu horário mesmo?"); cv.expect(says_when(cv.last_ai(), a0[0]), "prompt/modelo", f"não disse o dia e hora do PRÓPRIO pedido: {cv.last_ai()[60:240]!r}")
def _dois(cv, rep, ctx):
    d = pday(ctx, cv.org_key); cv.say(open_msg(cv, d, "de tarde")); flow_book(cv, style=rep); a0 = [a for a in cv.appts() if a["status"] == "pending_approval"]
    if not a0: cv.flag("harness", "sem pedido-base"); return
    d2 = pday(ctx, cv.org_key)
    if d2 == d: d2 = pday(ctx, cv.org_key)
    if not staff_book(cv, d2, FIRST_HOUR[cv.org_key]): cv.flag("harness", "equipe não conseguiu marcar o outro"); return
    cv.say("quais são os meus horários?"); ai = cv.last_ai(); st = {a["id"]: a for a in cv.turns[-1]["appointments"]}
    sch = [a for a in st.values() if a["status"] == "scheduled"]
    cv.expect(says_when(ai, a0[0]), "prompt/modelo", f"não citou o pedido pendente: {ai[60:260]!r}")
    if sch: cv.expect(says_when(ai, sch[0]), "prompt/modelo", f"não citou o horário marcado pela equipe: {ai[60:260]!r}")
    cv.expect(bool(re.search(r"aguard|pedido|equipe", ai, re.I)), "prompt/modelo", "não distinguiu o pendente")
for _o in ORGS5:
    REG.append(dict(id=f"F-A-meu-horario-{_o}", org=_o, sit="FA", desc="que dia é o meu horário", appts="any", handoff="any", reps=1, mode="propose", pair=False, fn=_meu, max_appts=None, tags=()))
    REG.append(dict(id=f"F-A-um-marcado-um-pendente-{_o}", org=_o, sit="FA", desc="cliente com 1 marcado (equipe) + 1 pendente", appts="any", handoff="any", reps=1, mode="propose", pair=False, fn=_dois, max_appts=None, tags=()))

def _cancela_ativo(cv, rep, ctx):
    d = pday(ctx, cv.org_key); cv.say(open_msg(cv, d, "de tarde")); flow_book(cv, style=rep)
    if not [a for a in cv.appts() if a["status"] == "pending_approval"]: cv.flag("harness", "sem pedido-base"); return
    cv.decide("decline")
    d2 = pday(ctx, cv.org_key)
    while d2 == d: d2 = pday(ctx, cv.org_key)
    if not staff_book(cv, d2, FIRST_HOUR[cv.org_key]): cv.flag("harness", "sem horário ativo"); return
    cv.say(f"cancela o de {WD_SHORT[d2.weekday()]}, por favor"); ai = cv.last_ai(); st = [a for a in cv.turns[-1]["appointments"] if a["status"] == "scheduled"]
    cv.expect(not (CANCEL_CLAIM2.search(ai) and not re.search(r"n[aã]o|equipe|passei|vou (?:pedir|repassar|avisar)|avis", ai, re.I)), "prompt/modelo", f"IA diz que cancelou: {ai[60:240]!r}")
    cv.expect(not re.search(r"\bcancelei\b|foi cancelad|j[aá] est[aá] cancelad", ai, re.I), "prompt/modelo", f"IA afirma cancelamento: {ai[60:240]!r}")
    cv.expect(len(st) == 1, "motor", "o horário ativo mudou sem a equipe")
    cv.expect(bool(cv.turns[-1]["handoffs"]), "prompt/modelo", "não repassou o pedido de cancelamento")
def _reservado(cv, rep, ctx):
    d = pday(ctx, cv.org_key); cv.say(open_msg(cv, d, "de tarde")); flow_book(cv, style=rep)
    if not cv.appts(): cv.flag("harness", "sem pedido-base"); return
    cv.say(["então já está reservado, né?", "legal, então ficou garantido o meu horário?"][rep % 2])
    for t in cv.turns[1:]:
        for txt in t["ai"]:
            for sent in re.split(r"(?<=[.!?\n])\s+", txt):
                if re.search(r"reservad|marcad|garantid|confirmad|agendad", sent, re.I) and not NEG.search(sent) and not sent.strip().endswith("?") and "pedido" not in sent.lower():
                    cv.flag("prompt/modelo", f"diz reservado/marcado com o pedido pendente: {sent[:160]!r}")
for _o in ORGS5:
    REG.append(dict(id=f"F-B-cancela-ativo-{_o}", org=_o, sit="FB", desc="horário ativo + pedido recusado: 'cancela o de X'", appts="any", handoff="any", reps=2, mode="propose", pair=False, fn=_cancela_ativo, max_appts=None, tags=()))
    REG.append(dict(id=f"F-B-reservado-{_o}", org=_o, sit="FB", desc="depois de registrar: não pode dizer reservado/marcado", appts="pending", handoff="any", reps=2, mode="propose", pair=False, fn=_reservado, max_appts=None, tags=()))

def _grupo(phrase, n, kind):
    def fn(cv, rep, ctx):
        d = pday(ctx, cv.org_key); cv.say(f"Oi! Queria {SV[cv.org_key]} {day_phrase(d)} {fix_period(cv.org_key, d, 'de tarde')} {phrase}")
        flow_book(cv, style=rep); act = [a for a in cv.appts() if a["status"] == "pending_approval"]
        if kind == "single":
            cv.expect(len(act) == 1 and not act[0].get("partyKey"), "prompt/modelo", f"falso positivo de grupo: {len(act)} agendamentos"); return
        if not act: cv.flag("obs", "sem pedido (sem vaga para o grupo ou a IA não registrou)"); return
        dump = cx("simAgendaRead:internalSimOrgDump", {"organizationId": cv.o["organizationId"]}); pk = act[0].get("partyKey")
        members = [a for a in dump["appointments"] if pk and a.get("partyKey") == pk and a["status"] in ACTIVE]
        cv.expect(len(members) == n and all(a["status"] == "pending_approval" for a in members), "prompt/modelo", f"grupo de {n}: {len(members)} agendamentos do grupo (partyKey={bool(pk)}), registrou {len(act)} pedido(s) enquanto a IA falou em {n} pessoas")
        if len(members) != n: return
        cv.decide("approve"); cv.say("e aí, confirmou?"); ai = cv.last_ai()
        dump = cx("simAgendaRead:internalSimOrgDump", {"organizationId": cv.o["organizationId"]})
        sc = [a for a in dump["appointments"] if a.get("partyKey") == pk and a["status"] == "scheduled"]
        cv.expect(len(sc) == n, "motor", f"aprovação do grupo deixou {len(sc)} de {n} marcados")
        cv.expect(bool(POS.search(ai)) and not re.search(r"aguardando|ainda n[aã]o", ai, re.I), "prompt/modelo", f"grupo aprovado e a IA não confirmou: {ai[60:260]!r}")
        cv.expect(bool(re.search(rf"{n}\s*pessoas|vocês|todos|os {n}|duas|três|grupo", ai, re.I)), "prompt/modelo", f"confirmou sem falar do grupo: {ai[60:260]!r}")
    return fn
for _id, _o, _ph, _n, _k, _r in [("casal", "clinica", "pra mim e pro meu marido, juntos", 2, "group", 2), ("somos3", "clinica", "somos 3, queremos juntos", 3, "group", 2), ("amiga", "pilates", "eu e a Ana, juntas na mesma turma", 2, "group", 2),
                                 ("somos3", "pilates", "somos 3 amigos, na mesma turma", 3, "group", 2), ("espera", "clinica", "minha filha vai comigo mas só espera", 1, "single", 1), ("indicou", "pilates", "meu marido me indicou o estúdio", 1, "single", 1),
                                 ("espera", "pilates", "minha filha vai comigo mas só espera na recepção", 1, "single", 1), ("indicou", "clinica", "meu marido me indicou vocês", 1, "single", 1)]:
    REG.append(dict(id=f"F-C-{_id}-{_o}", org=_o, sit="FC", desc="grupo: " + _ph, appts="any", handoff="any", reps=_r, mode="propose", pair=False, fn=_grupo(_ph, _n, _k), max_appts=None, tags=()))
