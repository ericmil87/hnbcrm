"""Situação E: fração das ofertas coladas em atendimento existente (e na borda do turno) por modo inteligente. Uso: analyze_E.py <tag>"""
import json, glob, os, sys, collections
sys.path.insert(0, os.path.dirname(__file__))
from core import *
ROOT_ = ROOT
def main(tag):
    dumps = {os.path.basename(p)[6:-5]: json.load(open(p)) for p in glob.glob(f"{ROOT_}/transcricoes/{tag}/_dump-*.json")}
    res = collections.defaultdict(lambda: collections.Counter()); detail = collections.defaultdict(list)
    for p in sorted(glob.glob(f"{ROOT_}/transcricoes/{tag}/E-*.json")):
        d = json.load(open(p)); r = d["row"]; org = r["org"]; dump = dumps[org]; mode = r["mode"].split(":")[1]
        svc_min = min(s["durationMin"] + s["bufferBeforeMin"] + s["bufferAfterMin"] for s in dump["services"])
        for t in d["convs"][0]["turns"]:
            offs = t["new_offers"]
            if not offs: res[(org, mode)]["conversas_sem_oferta"] += 1; continue
            for o in offs:
                svc = next(s for s in dump["services"] if s["id"] == o["serviceId"])
                bs = o["startTime"] - svc["bufferBeforeMin"] * 60000; be = o["startTime"] + (svc["durationMin"] + svc["bufferAfterMin"]) * 60000
                touch = False; edge = False; dead = False
                for rid in o["resourceIds"]:
                    rr = next(x for x in dump["resources"] if x["id"] == rid)
                    mine = [a for a in dump["appointments"] if a["status"] in ACTIVE and a["createdAt"] <= o["issuedAt"] and any(x["id"] == rid and x["allocated"] for x in a["resources"]) and a["localDate"] == ms_to_local(o["startTime"]).date().isoformat()]
                    if rr["capacity"] > 1: mine = [a for a in mine]  # sala de capacidade >1: vizinho = alocação não sobreposta
                    if any(abs(a["blockEnd"] - bs) < 1000 or abs(a["blockStart"] - be) < 1000 for a in mine if not (a["startTime"] < be and a["endTime"] > bs)): touch = True
                    wd = (ms_to_local(o["startTime"]).weekday() + 1) % 7
                    ivs = [w for w in rr["weekly"] if w["weekday"] == wd]
                    smin = ms_to_local(bs).hour * 60 + ms_to_local(bs).minute; emin = ms_to_local(be).hour * 60 + ms_to_local(be).minute
                    if any(abs(w["startMin"] - smin) < 1 or abs(w["endMin"] - emin) < 1 for w in ivs): edge = True
                    # buraco morto: lacuna (0, svc_min) entre o bloco e o vizinho/borda mais próximo
                    prev_ends = [a["blockEnd"] for a in mine if a["blockEnd"] <= bs]; next_starts = [a["blockStart"] for a in mine if a["blockStart"] >= be]
                    iv = next((w for w in ivs if w["startMin"] <= smin and emin <= w["endMin"]), None)
                    lo = max(prev_ends) if prev_ends else (local_to_ms(ms_to_local(bs).date(), iv["startMin"]) if iv else bs)
                    hi = min(next_starts) if next_starts else (local_to_ms(ms_to_local(bs).date(), iv["endMin"]) if iv else be)
                    for gap in ((bs - lo) / 60000, (hi - be) / 60000):
                        if 0 < gap < svc_min: dead = True
                c = res[(org, mode)]; c["ofertas"] += 1; c["coladas_em_atendimento"] += touch; c["coladas_ou_borda"] += (touch or edge); c["com_buraco_morto"] += dead
                detail[(org, mode)].append((ms_to_local(o["startTime"]).strftime("%d/%m %H:%M"), "colada" if touch else "borda" if edge else "solta", "buraco" if dead else ""))
    print(f"{'org':12} {'modo':9} {'ofertas':>7} {'coladas':>8} {'colada/borda':>13} {'c/ buraco':>10}")
    out = {}
    for (org, mode), c in sorted(res.items()):
        n = c["ofertas"] or 1
        print(f"{org:12} {mode:9} {c['ofertas']:7d} {c['coladas_em_atendimento']/n:8.0%} {c['coladas_ou_borda']/n:13.0%} {c['com_buraco_morto']/n:10.0%}  (sem oferta: {c['conversas_sem_oferta']})")
        out[f"{org}/{mode}"] = dict(c)
    json.dump(out, open(f"{ROOT_}/resultados-E-{tag}.json", "w"), indent=1)
if __name__ == "__main__": main(sys.argv[1])
