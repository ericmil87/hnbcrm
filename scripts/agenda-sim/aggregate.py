"""Agrega resultados-<tags>.jsonl em tabelas. Uso: aggregate.py tag1[,tag2] [--md]"""
import json, sys, os, collections, statistics
ROOT_ = os.environ.get("AGENDA_SIM_OUT", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "temp", "agenda-sim")))
def load(tags):
    rows = []
    for t in tags.split(","):
        p = f"{ROOT_}/resultados-{t}.jsonl"
        if os.path.exists(p): rows += [json.loads(l) for l in open(p)]
    return rows
def main(tags, overrides=None):
    rows = load(tags)
    ov = json.load(open(overrides)) if overrides and os.path.exists(overrides) else {}
    def effective(r):
        """falhas depois da revisão manual (overrides: id -> lista de índices de falhas descartadas, ou 'ok')."""
        o = ov.get(r["id"] + "|" + r["tag"])
        fl = list(r["fails"])
        if o == "ok": return []
        if isinstance(o, list): fl = [f for i, f in enumerate(fl) if i not in o]
        if isinstance(o, dict):
            fl = [f for i, f in enumerate(fl) if i not in o.get("drop", [])] + o.get("add", [])
        return fl
    for r in rows: r["eff_fails"] = effective(r); r["eff_pass"] = not r["eff_fails"]
    n = len(rows); ok = sum(r["eff_pass"] for r in rows)
    print(f"conversas: {n}  | acerto (após revisão): {ok}/{n} = {ok/max(n,1):.0%}  | acerto bruto do verificador: {sum(r['passed'] for r in rows)}/{n}")
    cost = sum(r.get("cost_usd", 0) for r in rows); print(f"custo (runs): ${cost:.4f}  por conversa: ${cost/max(n,1):.4f}")
    turns = [t for r in rows for t in r.get("latency_ms", [])]
    if turns: print(f"latência por turno: mediana {statistics.median(turns)/1000:.1f}s  p90 {sorted(turns)[int(len(turns)*0.9)]/1000:.1f}s")
    print("tool calls/conversa:", round(sum(r.get("tool_calls", 0) for r in rows)/max(n,1), 1), " rodadas/conversa:", round(sum(r.get("rounds", 0) for r in rows)/max(n,1), 1))
    sits = sorted({r["situation"] for r in rows}); orgs = ["clinica", "barbearia", "consultorio", "advogado", "pilates"]
    print("\nsituação × negócio (acertos/conversas)")
    print("sit  " + " ".join(f"{o[:10]:>11}" for o in orgs) + "   total")
    for s in sits:
        cells = []
        for o in orgs:
            rr = [r for r in rows if r["situation"] == s and r["org"] == o]
            cells.append(f"{sum(x['eff_pass'] for x in rr)}/{len(rr)}" if rr else "-")
        rs = [r for r in rows if r["situation"] == s]
        print(f"{s:4} " + " ".join(f"{c:>11}" for c in cells) + f"   {sum(x['eff_pass'] for x in rs)}/{len(rs)} ({sum(x['eff_pass'] for x in rs)/max(len(rs),1):.0%})")
    print("\npor negócio:")
    for o in orgs:
        rr = [r for r in rows if r["org"] == o]; print(f"  {o:12} {sum(x['eff_pass'] for x in rr)}/{len(rr)} ({sum(x['eff_pass'] for x in rr)/max(len(rr),1):.0%})")
    kinds = collections.Counter(f["kind"] for r in rows for f in r["eff_fails"]); print("\nfalhas por classe:", dict(kinds))
    print("conversas com ao menos uma falha por classe:", dict(collections.Counter(k for r in rows for k in {f['kind'] for f in r['eff_fails']})))
    print("\nFALHAS:")
    for r in sorted(rows, key=lambda r: r["id"]):
        if r["eff_fails"]:
            print(f"- {r['id']} [{r['org']}/{r['situation']}] " + " | ".join(f"{f['kind']}: {f['msg'][:150]}" for f in r["eff_fails"][:3]))
if __name__ == "__main__": main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
