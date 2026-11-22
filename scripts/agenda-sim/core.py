"""Núcleo do harness: conversa simulada (Cv), datas, verificação determinística. Só DEV."""
import json, re, time, threading, datetime as dt, os
from cx import cx

TZ = dt.timezone(dt.timedelta(hours=-3))   # America/Sao_Paulo (sem horário de verão desde 2019)
ROOT = os.environ.get("AGENDA_SIM_OUT", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "temp", "agenda-sim")))  # saída (gitignored)
for _d in ("cenarios", "transcricoes"): os.makedirs(os.path.join(ROOT, _d), exist_ok=True)
NAMES = ["Marina","Rafael","Beatriz","Lucas","Camila","Thiago","Juliana","Gustavo","Larissa","Felipe","Renata","Bruno","Patrícia","Diego","Aline","Vinícius","Fernanda","Leandro","Tatiane","Márcio","Priscila","André","Carolina","Rodrigo","Sabrina","Henrique","Vanessa","Caio","Daniela","Otávio"]
WD = ["segunda-feira","terça-feira","quarta-feira","quinta-feira","sexta-feira","sábado","domingo"]
WD_SHORT = ["segunda","terça","quarta","quinta","sexta","sábado","domingo"]
ACTIVE = {"pending_approval","scheduled","confirmed","checked_in","completed"}

def now_local(): return dt.datetime.now(TZ)
def today(): return now_local().date()
def ms_to_local(ms): return dt.datetime.fromtimestamp(ms/1000, TZ)
def local_to_ms(d, minutes): return int(dt.datetime(d.year,d.month,d.day,tzinfo=TZ).timestamp()*1000 + minutes*60000)
def hhmm(m): return f"{m//60:02d}:{m%60:02d}"

def day_phrase(d, now=None):
    t = (now or today())
    n = (d - t).days
    if n == 0: return "hoje"
    if n == 1: return "amanhã"
    if n == 2: return "depois de amanhã"
    if n <= 6: return WD_SHORT[d.weekday()]
    return f"{WD_SHORT[d.weekday()]} que vem" if n <= 13 else f"dia {d.day}"

def next_weekday(wd, min_days=1):
    """Próxima data (>= hoje+min_days) com weekday wd (0=segunda)."""
    d = today() + dt.timedelta(days=min_days)
    while d.weekday() != wd: d += dt.timedelta(days=1)
    return d

class Turn(dict): pass

class Cv:
    """Uma conversa: cliente fictício + turnos pelo pipeline real. Guarda tudo para a transcrição."""
    def __init__(self, ctx, org_key, scen_id, name=None, phone=None, idx=0):
        self.ctx = ctx; self.org_key = org_key; self.o = ctx["orgs"][org_key]; self.id = scen_id
        self.name = name or NAMES[idx % len(NAMES)]
        self.phone = phone or f"55999{abs(hash(scen_id))%10**7:07d}"
        self.c = None; self.turns = []; self.seen_codes = set(); self.notes = []; self.rename = None
        self.start_ms = int(time.time()*1000)
    def _ensure(self):
        if self.c is None:
            self.c = cx("simAgenda:internalSimNewCustomer", {"organizationId": self.o["organizationId"], "name": self.rename or self.name, "phone": self.phone})
            self.name = self.rename or self.name
    def flag(self, kind, msg): self.notes.append({"kind": kind, "msg": msg})
    def expect(self, cond, kind, msg):
        if not cond: self.flag(kind, msg)
    def _offered_at(self, d, minutes):
        ds = d if isinstance(d, str) else d.isoformat()
        return any(ms_to_local(o["startTime"]).date().isoformat()==ds and ms_to_local(o["startTime"]).hour*60+ms_to_local(o["startTime"]).minute==minutes for o in (self.turns[-1]["new_offers"] if self.turns else []))
    def expect_offered(self, d, minutes, msg): self.flag("obs", f"{'OFERECEU' if self._offered_at(d, minutes) else 'não ofereceu'} o horário pedido ({msg})")
    def expect_not_offered(self, d, minutes, msg): self.flag("obs", f"{'OFERECEU (!)' if self._offered_at(d, minutes) else 'não ofereceu'} o horário lotado ({msg})")
    def say(self, *texts, gap_ms=800, timeout_ms=170000):
        self._ensure(); t0 = time.time()
        r = cx("simAgenda:internalSimTurn", {"organizationId": self.o["organizationId"], "leadId": self.c["leadId"], "conversationId": self.c["conversationId"],
              "channelConfigId": self.c["channelConfigId"], "texts": list(texts), "gapMs": gap_ms, "timeoutMs": timeout_ms}, timeout=timeout_ms//1000+120)
        st = r["state"]; start = r["t0"]
        ai = [m for m in st["messages"] if m["direction"]=="outbound" and m["senderType"]=="ai" and m["createdAt"]>=start]
        new_offers = [o for o in st["offers"] if o["code"] not in self.seen_codes]
        prev_runs = {x["id"] for t in self.turns for x in t["runs_new"]}
        runs_new = [x for x in st["runs"] if x["id"] not in prev_runs]
        self.seen_codes |= {o["code"] for o in st["offers"]}
        turn = Turn(sent=list(texts), ai=[m["content"] for m in ai], ai_msgs=ai, verdict=r["verdict"], elapsed_ms=r["elapsedMs"], new_offers=new_offers, offers_all=st["offers"],
                    runs_new=runs_new, appointments=st["appointments"], handoffs=st["handoffs"], queue=st["queue"], t0=start, wall_s=round(time.time()-t0,1))
        self.turns.append(turn); self.state = st
        return turn
    def last_ai(self): return "\n".join(self.turns[-1]["ai"]) if self.turns else ""
    def shown(self, turn=None):
        """Ofertas emitidas no turno e já mostradas ao cliente (shownAt)."""
        t = turn or self.turns[-1]
        return [o for o in t["new_offers"] if o["shownAt"]]
    def shown_any(self):
        """Ofertas mostradas no turno mais recente que trouxe ofertas novas."""
        for t in reversed(self.turns):
            sh = [o for o in t["new_offers"] if o["shownAt"]]
            if sh: return sh
        return []
    def appts(self, active_only=True):
        a = self.turns[-1]["appointments"] if self.turns else []
        return [x for x in a if (x["status"] in ACTIVE or not active_only)]
    def has_handoff(self): return len(self.turns[-1]["handoffs"]) > 0 if self.turns else False
    def age_offers(self, minutes):
        self._ensure()
        return cx("simAgenda:internalSimAgeOffers", {"organizationId": self.o["organizationId"], "conversationId": self.c["conversationId"], "minutes": minutes})

def pick_text(offer, style=0):
    d = ms_to_local(offer["startTime"]); h, m = d.hour, d.minute
    hm = f"{h}h" if m == 0 else f"{h}h{m:02d}"
    h12 = h % 12 or 12; per = "da manhã" if h < 12 else "da tarde" if h < 18 else "da noite"
    h12s = f"{h12}" if m == 0 else f"{h12}:{m:02d}"
    return [f"pode ser às {hm}", f"quero o das {hm}", f"o das {h12s} {per}", f"{h:02d}:{m:02d} fica bom", f"fecha às {hm} pra mim"][style % 5]

# ───────────────────────── verificação determinística ─────────────────────────
def parse_times(text):
    """Horários citados no texto da IA: lista de (dia|None, minutos|None) com o trecho."""
    t = text
    # remove faixas de funcionamento ("das 9h às 12h", "9h às 12h", "de 9h a 12h", "9h-12h", "8h às 18h")
    t = re.sub(r"(?:das?|de)?\s*\d{1,2}\s*(?:h|hs|:)\s*(?:\d{2})?\s*(?:às|as|a|-|até)\s*\d{1,2}\s*(?:h|hs|:)?\s*(?:\d{2})?", " [faixa] ", t, flags=re.I)
    t = re.sub(r"R\$\s*[\d.,]+", " ", t)
    out = []
    for m in re.finditer(r"(?<![\d/])(\d{1,2})\s*(?:h|hs|:)\s*(\d{2})?(?!\d)", t, flags=re.I):
        h = int(m.group(1)); mi = int(m.group(2) or 0)
        if h <= 24 and mi < 60: out.append((h*60+mi, m.group(0).strip()))
    for m in re.finditer(r"(?:às|as|pras|para as)\s+(\d{1,2})(?!\d|\s*(?:/|de |dias|min|pessoas|reais|vagas))(\s+da\s+(manhã|tarde|noite))?", t, flags=re.I):
        h = int(m.group(1)); per = (m.group(3) or "").lower()
        if per in ("tarde","noite") and h < 12: h += 12
        if h <= 24: out.append((h*60, m.group(0).strip()))
    return out

CLAIM = re.compile(r"(?:\best[aá]\s+|\bficou\s+|\bfoi\s+|\bj[aá]\s+est[aá]\s+|\bfica\s+)(?:marcad|agendad|confirmad|reservad|garantid)|\b(?:marquei|agendei|confirmei|reservei|garanti)\b|\b(?:marcad|agendad|confirmad)[oa]\s+(?:para|pra|no|na|às|as)\b|\bhor[aá]rio\s+(?:marcad|confirmad|garantid|reservad)", re.I)
HEDGE = re.compile(r"aguardand|aguarda\b|depende|quando a equipe|assim que|equipe\s+(?:vai\s+|ir[aá]\s+)?confirm|pedido|ainda n[aã]o|para confirmar|vai confirmar|confirmar[aã]|sujeito|a confirmar|se (?:a equipe|der)|tento|vou (?:pedir|verificar|confirmar|passar)|n[aã]o (?:est[aá]|foi|consigo|posso|tenho|vou|sei|d[aá])|sem (?:a equipe|confirma)", re.I)

def active_set(dump, at_ms=None, exclude=None):
    out = []
    for a in dump["appointments"]:
        if a["status"] not in ACTIVE: continue
        if at_ms is not None and a["createdAt"] > at_ms: continue
        if exclude and a["id"] == exclude: continue
        out.append(a)
    return out

def weekly_ok(res, start_ms, end_ms):
    d = ms_to_local(start_ms); wd = (d.weekday()+1) % 7   # convex: 0 = domingo
    s = d.hour*60+d.minute; e = s + int(round((end_ms-start_ms)/60000))
    return any(w["weekday"]==wd and w["startMin"]<=s and e<=w["endMin"] for w in res["weekly"])

def exception_state(dump, res, date_str):
    """Devolve (closed, custom_intervals|None, extra_intervals, blocks) para o recurso nesse dia."""
    closed = False; custom = None; extra = []; blocks = []
    for e in dump["exceptions"]:
        if e["localDate"] != date_str: continue
        applies = (e["resourceId"] == res["id"]) or (e["resourceId"] is None and (e["resourceKind"] in (None, res["kind"])))
        if not applies: continue
        if e["mode"] == "closed": closed = True
        elif e["mode"] == "custom": custom = e["intervals"]
        elif e["mode"] == "extra": extra += e["intervals"]
        elif e["mode"] == "block": blocks += e["intervals"]
    return closed, custom, extra, blocks

def peak(ivs):
    """Pico de simultaneidade de uma lista de intervalos [a, b)."""
    ev = sorted([(a, 1) for a, b in ivs] + [(b, -1) for a, b in ivs], key=lambda x: (x[0], x[1]))
    cur = best = 0
    for _, d in ev:
        cur += d; best = max(best, cur)
    return best

def check_plan(dump, service_id, start_ms, resource_ids, now_ms, at_ms=None, exclude=None, origin_ai=True, people=1):
    """Regras do motor aplicadas a um horário (oferta ou agendamento). Devolve lista de violações (strings)."""
    probs = []
    svc = next(s for s in dump["services"] if s["id"] == service_id)
    res_by = {r["id"]: r for r in dump["resources"]}
    settings = dump["settings"] or {}
    grid = settings.get("gridMinutes", 30)
    minNotice = svc["minNoticeMin"] if svc["minNoticeMin"] is not None else settings.get("minNoticeMin", 120)
    maxAdv = svc["maxAdvanceDays"] if svc["maxAdvanceDays"] is not None else settings.get("maxAdvanceDays", 60)
    end_ms = start_ms + svc["durationMin"]*60000
    bs = start_ms - svc["bufferBeforeMin"]*60000; be = end_ms + svc["bufferAfterMin"]*60000
    d = ms_to_local(start_ms); date_str = d.date().isoformat()
    ref = at_ms if at_ms is not None else now_ms
    if origin_ai:
        if start_ms - ref < minNotice*60000 - 1000: probs.append(f"ANTECEDENCIA {int((start_ms-ref)/60000)}min < {minNotice}")
        if (d.date() - ms_to_local(ref).date()).days > maxAdv: probs.append(f"ALEM_DO_LIMITE {maxAdv}d")
    if start_ms < ref - 1000: probs.append("NO_PASSADO")
    # requisitos
    reqs = svc["requirements"]; used = set()
    for q in reqs:
        cand = [rid for rid in resource_ids if rid in res_by and res_by[rid]["kind"] == q["kind"] and rid not in used
                and (not q.get("resourceIds") or rid in q["resourceIds"]) and (not q.get("tag") or q["tag"] in res_by[rid]["tags"])]
        if len(cand) < (q.get("units") or 1) and (q.get("units") or 1) == 1: probs.append(f"REQUISITO_NAO_ATENDIDO {q['role']}")
        else: used.update(cand[:1])
    for rid in resource_ids:
        r = res_by.get(rid)
        if not r: probs.append("RECURSO_DESCONHECIDO"); continue
        if not r["active"]: probs.append(f"RECURSO_INATIVO {r['name']}")
        closed, custom, extra, blocks = exception_state(dump, r, date_str)
        if closed: probs.append(f"RECURSO_FECHADO {r['name']} {date_str}")
        s_min = d.hour*60+d.minute; e_min = s_min + svc["durationMin"]
        if custom is not None: ok = any(i["startMin"]<=s_min and e_min<=i["endMin"] for i in custom)
        else: ok = weekly_ok(r, start_ms, end_ms) or any(i["startMin"]<=s_min and e_min<=i["endMin"] for i in extra)
        if not ok and not closed: probs.append(f"FORA_DO_EXPEDIENTE {r['name']} {hhmm(s_min)}")
        for b in blocks:
            if s_min < b["endMin"] and e_min > b["startMin"]: probs.append(f"BLOQUEIO {r['name']}")
        # capacidade: núcleo; capacidade 1 também não pode sobrepor bloco (folga)
        conc = 0; clash_block = False; ivs = []
        for a in active_set(dump, at_ms, exclude):
            if not any(x["id"]==rid and x["allocated"] for x in a["resources"]): continue
            if a["startTime"] < end_ms and a["endTime"] > start_ms: ivs.append((max(a["startTime"], start_ms), min(a["endTime"], end_ms)))
            if r["capacity"] == 1 and a["blockStart"] < be and a["blockEnd"] > bs: clash_block = True
        conc = peak(ivs)
        units = 1
        if conc + units > r["capacity"]: probs.append(f"CAPACIDADE {r['name']} {conc}+{units}>{r['capacity']}")
        elif clash_block and conc == 0: probs.append(f"FOLGA_SOBREPOSTA {r['name']}")
    if (start_ms // 60000) % grid != 0 and not svc.get("slotIntervalMin"):
        m = ms_to_local(start_ms); 
        if (m.hour*60+m.minute) % grid: probs.append(f"FORA_DA_GRADE {m.strftime('%H:%M')} grade {grid}")
    return probs

def overcap_problems(dump):
    """assertNoOvercapacity por consulta: pico por recurso no núcleo (agendamentos ativos)."""
    out = []
    res_by = {r["id"]: r for r in dump["resources"]}
    for r in dump["resources"]:
        rows = [a for a in dump["appointments"] if a["status"] in ACTIVE and any(x["id"]==r["id"] and x["allocated"] for x in a["resources"])]
        for a in rows:
            conc = peak([(max(b["startTime"], a["startTime"]), min(b["endTime"], a["endTime"])) for b in rows if b["startTime"] < a["endTime"] and b["endTime"] > a["startTime"]])
            if conc > r["capacity"]: out.append(f"OVERCAPACITY {r['name']} {ms_to_local(a['startTime']).strftime('%d/%m %H:%M')} {conc}>{r['capacity']}"); break
    return out
