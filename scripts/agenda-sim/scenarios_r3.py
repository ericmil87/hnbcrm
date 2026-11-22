"""Rodada 2: ciclo IA propõe -> equipe decide (R-A), IA marca sozinha (R-B), perguntas comuns (R-E). Registra em scenarios.REG."""
import re
from core import *
from scenarios import *
from scenarios import REG, pday, open_msg, flow_book, fix_period, SV

# ═════════════════════ RODADA 2 ═════════════════════
import copy
def _clone(old, new, **over):
    base = next(x for x in REG if x["id"] == old); e = dict(base); e.update(id=new, **over); REG.append(e)

POS = re.compile(r"confirmad|marcad|aprovad|est[aá] (?:tudo )?certo|pode vir|tudo certo|garantid|agendad", re.I)
NEG = re.compile(r"ainda n[aã]o|n[aã]o (?:foi|est[aá]|consegu|deu|d[aá]|tem|houve|ficou)|aguard|recus|indispon|infelizmente|n[aã]o p[ou]d", re.I)
ORGS5 = ["clinica", "barbearia", "consultorio", "advogado", "pilates"]

def _cycle(kind):
    def fn(cv, rep, ctx):
        d = pday(ctx, cv.org_key); cv.say(open_msg(cv, d, "de tarde")); flow_book(cv, style=rep)
        pend = [a for a in cv.appts() if a["status"] == "pending_approval"]
        if not pend: cv.flag("harness", "não conseguiu criar o pedido-base"); cv.inconclusive = True; return
        if kind == "approve": cv.decide("approve")
        elif kind == "decline": cv.decide("decline")
        else: cv.expire()
        cv.say(["e aí, confirmou?", "oi, deu certo meu horário?"][rep % 2])
        ai = cv.last_ai(); st = cv.turns[-1]["appointments"]; mine = [a for a in st if a["origin"] == "ai"]
        newoffers = [o for o in cv.turns[-1]["new_offers"]]
        if kind == "approve":
            cv.expect(any(a["status"] == "scheduled" for a in mine), "motor", "aprovação não virou scheduled")
            cv.expect(bool(POS.search(ai)) and not re.search(r"aguardando|ainda n[aã]o", ai, re.I), "prompt/modelo", f"equipe aprovou e a IA não confirmou: {ai[100:260]!r}")
        elif kind == "decline":
            cv.expect(not any(a["status"] in ("scheduled", "pending_approval", "confirmed") for a in mine), "motor", "recusa não cancelou")
            cv.expect(not (POS.search(ai) and not NEG.search(ai)), "prompt/modelo", f"equipe recusou e a IA diz que está marcado: {ai[100:260]!r}")
            cv.flag("obs", "recusa: " + ("ofereceu outro horário" if newoffers or re.search(r"outro|alternativ|prefere|hor[aá]rios", ai, re.I) else "NÃO ofereceu outro") + " | " + ai[100:240].replace("\n", " "))
        else:
            cv.expect(not (POS.search(ai) and not NEG.search(ai)), "prompt/modelo", f"proposta venceu e a IA diz que está marcado/confirmado: {ai[100:260]!r}")
            cv.flag("obs", "vencida: " + ai[100:260].replace("\n", " "))
    return fn
for _k in ("approve", "decline", "expire"):
    for _o in ORGS5:
        REG.append(dict(id=f"R-A-{_k}-{_o}", org=_o, sit="RA", desc=f"ciclo IA propõe -> equipe {_k}: frase da IA x estado", appts="any", handoff="any", reps=2, mode="propose", pair=False, fn=_cycle(_k), max_appts=None, tags=()))

# B: IA marca sozinha (org em auto): clones dos cenários comuns
for _o in ORGS5: _clone(f"A-{_o}", f"R-B-feliz-{_o}", appts="scheduled", mode="auto", reps=2)
for _id in ["B-clinica-almoco", "B-barbearia-sabado-cheio", "B-consultorio-almoco", "B-advogado-manha", "B-pilates-fora-turma", "B-advogado-hoje",
            "C-clinica-ultima-vaga", "C-clinica-disputa", "C-pilates-ultima-vaga", "C-pilates-disputa", "C-barbearia-disputa", "D-clinica-2-salas", "D-clinica-1-sala",
            "F-pref-barbeiro", "F-pref-profissional", "F-pref-dentista"]:
    _clone(_id, "R-B-" + _id, mode="auto", reps=1, appts=("scheduled" if next(x for x in REG if x["id"] == _id)["appts"] == "pending" else next(x for x in REG if x["id"] == _id)["appts"]))
for _id in ["F-grupo-clinica", "F-grupo-pilates"]: _clone(_id, "R-B-" + _id, mode="auto", reps=1)  # em auto o grupo TEM de ficar pending_approval
def _muda(cv, rep, ctx):
    d = pday(ctx, cv.org_key); cv.say(open_msg(cv, d, "de tarde")); flow_book(cv, style=rep)
    a0 = [a for a in cv.appts()]
    if not a0: cv.flag("harness", "sem agendamento-base"); cv.inconclusive = True; return
    cv.say("na verdade prefiro mais tarde, umas 16h, pode trocar?")
    a1 = cv.appts(); ai = cv.last_ai()
    cv.expect(len(a1) == 1 and a1[0]["id"] == a0[0]["id"] and a1[0]["startTime"] == a0[0]["startTime"], "motor", "o horário marcado mudou (a IA não remarca)")
    cv.expect(not re.search(r"remarqu|troquei|alterei|mudei para|passei para as 16", ai, re.I) or NEG.search(ai) is not None, "prompt/modelo", f"IA afirma ter remarcado: {ai[100:240]!r}")
    cv.expect(bool(cv.turns[-1]["handoffs"]), "prompt/modelo", "não repassou a mudança à equipe")
def _dedupe(cv, rep, ctx):
    d = pday(ctx, cv.org_key); cv.say(open_msg(cv, d, "de tarde")); flow_book(cv, style=rep)
    a0 = cv.appts()
    if not a0: cv.flag("harness", "sem agendamento-base"); cv.inconclusive = True; return
    t = ms_to_local(a0[0]["startTime"]); cv.say(f"oi! queria marcar {SV[cv.org_key]} {day_phrase(t.date())} às {t.hour}h{'' if t.minute == 0 else format(t.minute, '02d')} (acho que esqueci de marcar)")
    flow_book(cv, style=rep + 1) if cv.shown_any() and len(cv.appts()) < 1 else None
    cv.expect(len([a for a in cv.appts()]) == 1, "motor", f"{len(cv.appts())} agendamentos ativos do mesmo cliente (dedupe)")
for _o in ORGS5:
    REG.append(dict(id=f"R-B-muda-depois-{_o}", org=_o, sit="RB", desc="auto: cliente muda de ideia depois de marcado: IA não remarca, repassa", appts="scheduled", handoff="yes", reps=1, mode="auto", pair=False, fn=_muda, max_appts=1, tags=()))
    REG.append(dict(id=f"R-B-dedupe-{_o}", org=_o, sit="RB", desc="auto: marcar o mesmo horário duas vezes por engano", appts="scheduled", handoff="any", reps=1, mode="auto", pair=False, fn=_dedupe, max_appts=1, tags=()))

# E: perguntas comuns ao lado da agenda
def _price_book(cv, rep, ctx):
    d = pday(ctx, cv.org_key); cv.say(f"oi, quanto custa {SV[cv.org_key]} e tem horário {day_phrase(d)} {fix_period(cv.org_key, d, 'de tarde')}?"); flow_book(cv, style=rep)
def _where(cv, rep, ctx):
    d = pday(ctx, cv.org_key); cv.say(open_msg(cv, d, "de manhã")); cv.say("onde fica mesmo? tem estacionamento?"); flow_book(cv, style=rep)
    cv.expect(bool(re.search(r"rua|av\.|avenida|estaciona", " ".join(" ".join(t["ai"]) for t in cv.turns[1:2]), re.I)), "prompt/modelo", "não respondeu onde fica")
def _vanish(cv, rep, ctx):
    d = pday(ctx, cv.org_key); cv.say(open_msg(cv, d, "de tarde")); sh = cv.shown()
    if not sh: cv.flag("harness", "sem ofertas"); cv.inconclusive = True; return
    cv.age_offers(60 * 26); cv.say("oi, desculpa sumir! pode ser o das " + pick_text(sh[0], 0).split("às ")[-1]); flow_book(cv, style=1) if not cv.appts() and cv.shown_any() and cv.turns[-1]["new_offers"] else None
def _only_yes(cv, rep, ctx):
    cv.say("sim"); cv.expect(not cv.appts() and not any(re.search(r"marcad|confirmad|registrad", x) for x in cv.turns[-1]["ai"]), "prompt/modelo", "IA agiu/afirmou com um 'sim' solto no começo")
def _my_slot(cv, rep, ctx):
    d = pday(ctx, cv.org_key); cv.say(open_msg(cv, d, "de tarde")); flow_book(cv, style=rep)
    a0 = cv.appts()
    if not a0: cv.flag("harness", "sem agendamento-base"); cv.inconclusive = True; return
    cv.say("que dia é mesmo o meu horário?"); ai = cv.last_ai(); t = ms_to_local(a0[0]["startTime"])
    cv.expect(t.strftime("%d/%m") in ai or WD_SHORT[t.weekday()] in ai.lower() or "amanhã" in ai.lower() or "segunda" in ai.lower(), "prompt/modelo", f"não disse o dia do PRÓPRIO horário: {ai[100:240]!r}")
for _id, _o, _fn, _r in [("R-E-preco-marcar-clinica", "clinica", _price_book, 1), ("R-E-preco-marcar-barbearia", "barbearia", _price_book, 1), ("R-E-onde-fica-consultorio", "consultorio", _where, 1),
                         ("R-E-onde-fica-pilates", "pilates", _where, 1), ("R-E-some-e-volta-clinica", "clinica", _vanish, 1), ("R-E-some-e-volta-barbearia", "barbearia", _vanish, 1),
                         ("R-E-so-sim-clinica", "clinica", _only_yes, 1), ("R-E-so-sim-pilates", "pilates", _only_yes, 1), ("R-E-meu-horario-consultorio", "consultorio", _my_slot, 1), ("R-E-meu-horario-advogado", "advogado", _my_slot, 1)]:
    REG.append(dict(id=_id, org=_o, sit="RE", desc="pergunta comum ao lado da agenda", appts="any", handoff="any", reps=_r, mode="propose", pair=False, fn=_fn, max_appts=None, tags=()))
