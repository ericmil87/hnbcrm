import json, sys, glob, os
sys.path.insert(0, os.path.dirname(__file__))
from core import ms_to_local
def show(path, full=False):
    d = json.load(open(path)); r = d["row"]
    print("="*100); print(r["id"], "|", r["desc"], "| passou" if r["passed"] else "| FALHOU", "| custo", r.get("cost_usd"), "| turnos", r.get("turns"), "rodadas", r.get("rounds"), "tools", r.get("tools"))
    for f in r["fails"]: print("  FALHA", f["kind"], "-", f["msg"][:260])
    for x in r["review"]: print("  REVISAR", x[:260])
    for x in r["obs"]: print("  obs", (x["msg"] if isinstance(x, dict) else x)[:200])
    for cv in d["convs"]:
        print(" --", cv["name"])
        for t in cv["turns"]:
            for s in t["sent"]: print("   C:", s)
            for a in t["ai"]: print("   IA:", a.replace("\n", " ⏎ ")[:700])
            if t["new_offers"]: print("   [ofertas]", [ms_to_local(o["startTime"]).strftime("%a %d/%m %H:%M") for o in t["new_offers"]])
            if t["appointments"]: print("   [agend]", [(ms_to_local(a["startTime"]).strftime("%d/%m %H:%M"), a["status"], [x["name"] for x in a["resources"]]) for a in t["appointments"]])
            if t["handoffs"]: print("   [repasse]", [h["reason"][:70] for h in t["handoffs"]])
if __name__ == "__main__":
    for p in sys.argv[1:]: show(p)
