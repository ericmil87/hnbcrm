"""Semeia as 5 orgs de cenário no DEV (uma vez por dia-base). Datas relativas a HOJE. Grava cenarios/ctx.json."""
import json, sys, os, datetime as dt, time
sys.path.insert(0, os.path.dirname(__file__))
from cx import cx
from core import today, now_local, ROOT, TZ
import importlib

def load_base():
    ns = {"__file__": os.path.join(os.path.dirname(os.path.abspath(__file__)), "gen_orgs.py")}
    src = open(os.path.join(os.path.dirname(__file__), "gen_orgs.py")).read().split("json.dump(")[0]
    exec(src, ns)
    return ns["orgs"]

def main(suffix=""):
    orgs = load_base()
    t = today(); wd = t.weekday()
    def off(d): return (d - t).days
    def nxt(w, mind=1):
        d = t + dt.timedelta(days=mind)
        while d.weekday() != w: d += dt.timedelta(days=1)
        return d
    mon, tue, wed, thu, fri, sat = nxt(0), nxt(1), nxt(2), nxt(3), nxt(4), nxt(5)
    # mon pode ser < tue na semana corrente; ordena por proximidade real
    ctx = {"seed_date": t.isoformat(), "dates": {k: v.isoformat() for k, v in dict(mon=mon, tue=tue, wed=wed, thu=thu, fri=fri, sat=sat).items()}, "orgs": {}}
    extra = {}
    # ── clínica
    c = orgs["clinica"]
    c["exceptions"] = [
      {"resourceKey":"sd","dayOffset":off(tue),"mode":"closed","reasonCode":"no_staff"},
      {"resourceKey":"sd","dayOffset":off(wed),"mode":"closed","reasonCode":"no_staff"},
      {"resourceKey":"s2","dayOffset":off(wed),"mode":"closed","reasonCode":"no_staff"},
      {"resourceKey":"p3","dayOffset":off(wed),"mode":"closed","reasonCode":"day_off"},
      {"resourceKey":"p4","dayOffset":off(wed),"mode":"closed","reasonCode":"day_off"},
      {"dayOffset":off(fri),"mode":"closed","reasonCode":"holiday"},
    ]
    # janela extra HOJE (para 'hoje ainda'): s1 + p1 de agora até +3h30 (acabando no fim do dia local)
    nm = now_local(); start = ((nm.hour*60+nm.minute)//30+1)*30; end = min(start+210, 23*60+30)
    if end - start >= 60:
        hh = lambda m: f"{m//60:02d}:{m%60:02d}"
        c["exceptions"] += [{"resourceKey":"s1","dayOffset":0,"mode":"extra","intervals":[{"start":hh(start),"end":hh(end)}]},
                            {"resourceKey":"p1","dayOffset":0,"mode":"extra","intervals":[{"start":hh(start),"end":hh(end)}]}]
    ctx["today_extra"] = [start, end]
    c["appointments"] = [
      {"service":"Massoterapia","dayOffset":off(mon),"time":"10:00","resourceKeys":["s1","p1"],"name":"Paciente Fictícia 1"},
      {"service":"Acupuntura","dayOffset":off(mon),"time":"15:00","resourceKeys":["s1","p1"],"name":"Paciente Fictícia 2"},
      {"service":"Massoterapia","dayOffset":off(mon),"time":"11:00","resourceKeys":["sd","p2"],"name":"Paciente Fictícia 3"},
    ]
    extra["clinica"] = [
      {"service":"Massoterapia","dayOffset":off(thu),"time":"10:00","resourceNames":["Sala 1","Terapeuta Ana"],"name":"Paciente Fictícia 4"},
      {"service":"Massoterapia","dayOffset":off(thu),"time":"10:00","resourceNames":["Sala 2","Terapeuta Bruno"],"name":"Paciente Fictícia 5"},
      {"service":"Massoterapia","dayOffset":off(thu),"time":"10:00","resourceNames":["Sala dupla","Terapeuta Carla"],"name":"Paciente Fictícia 6"},
      {"service":"Massoterapia","dayOffset":off(thu),"time":"10:00","resourceNames":["Sala dupla","Terapeuta Davi"],"name":"Paciente Fictícia 7"},
      {"service":"Massoterapia","dayOffset":off(thu),"time":"11:00","resourceNames":["Sala 1","Terapeuta Ana"],"name":"Paciente Fictícia 8"},
      {"service":"Massoterapia","dayOffset":off(thu),"time":"11:00","resourceNames":["Sala 2","Terapeuta Bruno"],"name":"Paciente Fictícia 9"},
      {"service":"Massoterapia","dayOffset":off(thu),"time":"11:00","resourceNames":["Sala dupla","Terapeuta Carla"],"name":"Paciente Fictícia 10"},
    ]
    k = 11
    for tm in ["14:00", "15:00", "16:00", "17:00", "09:00"]:   # mais três horários com 1 vaga só (sala dupla), um por repetição
        for rn, pn in [("Sala 1","Terapeuta Ana"),("Sala 2","Terapeuta Bruno"),("Sala dupla","Terapeuta Carla")]:
            k += 1; extra["clinica"].append({"service":"Massoterapia","dayOffset":off(thu),"time":tm,"resourceNames":[rn,pn],"name":f"Paciente Fictícia {k}"})
    # ── barbearia: sábado cheio, menos 10:30 (Rui) e 16:00 (Léo); Tato de folga na terça
    b = orgs["barbearia"]
    b["exceptions"] = [{"resourceKey":"tato","dayOffset":off(tue),"mode":"closed","reasonCode":"day_off"}]
    slots = [f"{h:02d}:{m:02d}" for h in range(9,12) for m in (0,30)] + [f"{h:02d}:{m:02d}" for h in range(13,19) for m in (0,30)]
    fill = []; n = 0
    for who in ["Rui","Tato","Léo"]:
        for sl in slots:
            if (who, sl) in (("Rui","10:30"), ("Léo","16:00")): continue
            n += 1; fill.append({"service":"Corte","dayOffset":off(sat),"time":sl,"resourceNames":[who],"name":f"Cliente Fictício B{n}"})
    for who, tms in [("Rui", ["10:00", "15:00"]), ("Tato", ["09:00", "13:30", "17:00"]), ("Léo", ["11:30", "16:30"])]:
        for tm in tms:
            n += 1; fill.append({"service":"Corte","dayOffset":off(fri),"time":tm,"resourceNames":[who],"name":f"Cliente Fictício B{n}"})
    extra["barbearia"] = fill
    ctx["sat_free"] = "16:00"
    # ── consultório: Marcos de folga na segunda
    d_ = orgs["consultorio"]
    d_["exceptions"] = [{"resourceKey":"marcos","dayOffset":off(mon),"mode":"closed","reasonCode":"day_off"}]
    d_["appointments"] = [
      {"service":"Avaliação","dayOffset":off(mon),"time":"09:00","resourceKeys":["helena"],"name":"Paciente Fictício 11"},
      {"service":"Procedimento","dayOffset":off(tue),"time":"14:00","resourceKeys":["helena"],"name":"Paciente Fictício 12"},
    ]
    # ── advogado: uma consulta na quarta 15h
    orgs["advogado"]["appointments"] = [{"service":"Consulta jurídica","dayOffset":off(wed),"time":"15:00","name":"Cliente Fictício 13"}]
    # ── pilates: terça 18h lotada (4/4), 19h com 3/4; quarta 19h com 3/4
    pl = orgs["pilates"]
    mk = lambda d, tm, i: {"service":"Aula de pilates","dayOffset":off(d),"time":tm,"resourceKeys":["studio"],"name":f"Aluno Fictício P{d.day}{tm[:2]}{i}"}
    pl["appointments"] = [mk(tue,"18:00",i) for i in range(4)] + [mk(tue,"19:00",i) for i in range(3)]
    extra["pilates"] = [{"service":"Aula de pilates","dayOffset":off(d),"time":"19:00","resourceNames":["Sala de pilates"],"name":f"Aluno Fictício Q{d.day}{i}"} for d in (wed, thu, fri) for i in range(3)] + [{"service":"Aula de pilates","dayOffset":off(mon),"time":"19:00","resourceNames":["Sala de pilates"],"name":f"Aluno Fictício R{i}"} for i in range(3)] + [{"service":"Aula de pilates","dayOffset":off(tue),"time":"07:00","resourceNames":["Sala de pilates"],"name":f"Aluno Fictício S{i}"} for i in range(3)]
    ctx["thu"], ctx["holiday"], ctx["sat"] = thu.isoformat(), fri.isoformat(), sat.isoformat()
    ctx["pil_day"], ctx["pil_day2"] = tue.isoformat(), wed.isoformat()
    for key, spec in orgs.items():
        spec = dict(spec); spec["slug"] = spec["slug"] + suffix
        r = cx("simAgenda:internalSeedScenarioOrg", {"spec": spec}, timeout=600)
        ctx["orgs"][key] = r
        print(key, "semeada", r["organizationId"], "appts", r["appointmentsCreated"], flush=True)
        ex = extra.get(key, [])
        for i in range(0, len(ex), 6):
            rr = cx("simAgenda:internalSimAddAppointments", {"organizationId": r["organizationId"], "appointments": ex[i:i+6]}, timeout=600)
            if rr["failed"]: print("  falhas:", rr["failed"])
        print("   extras:", len(ex), flush=True)
    json.dump(ctx, open(os.path.join(ROOT, "cenarios", f"ctx{suffix}.json"), "w"), ensure_ascii=False, indent=1)

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "")
