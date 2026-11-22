"""Cliente 'livre': um LLM barato faz o papel do cliente (conversa não roteirizada) contra o pipeline real. Chave só em memória."""
import json, os, sys, subprocess, urllib.request, threading, argparse, time
sys.path.insert(0, os.path.dirname(__file__))
from core import *
import run as R

GOALS = [
 ("clinica", "Você quer uma massagem para dor nas costas. Prefere terça ou quarta à tarde, mas na terça tem reunião às 15h. Antes de marcar pergunta o preço. No fim confirma um horário que a atendente oferecer."),
 ("clinica", "Você quer marcar uma sessão para você e sua irmã juntas, no mesmo horário, amanhã ou depois de amanhã."),
 ("clinica", "Você só pode sábado à tarde e insiste nisso, mesmo ouvindo que não tem. Depois de duas tentativas aceita ir de manhã."),
 ("barbearia", "Você quer corte e barba no sábado de manhã com o Rui. Depois de ver os horários muda de ideia e pede sexta à tarde."),
 ("barbearia", "Você pergunta se dá para cortar o cabelo ainda hoje à noite. Se não der, aceita amanhã cedo, o mais cedo possível."),
 ("consultorio", "Está com dor de dente e quer uma avaliação o mais rápido possível. Pergunta se dá para já fazer um procedimento direto, sem avaliação."),
 ("consultorio", "Quer cancelar a avaliação de quinta (que na verdade não existe no sistema) e em seguida marcar uma nova para a semana que vem de manhã."),
 ("advogado", "Precisa de consulta urgente, insiste em amanhã de manhã. Quando ouvir que só atende à tarde, pede para a atendente abrir uma exceção. Depois aceita um horário à tarde e pergunta se pode pagar depois."),
 ("advogado", "Só pode na sexta da semana que vem às 17h. Se houver ofertas, escolhe pelo texto 'o último'."),
 ("pilates", "Nunca fez pilates, quer uma aula experimental de manhã, pergunta se pode levar uma amiga e quanto custa."),
 ("pilates", "Quer fazer aula toda segunda e quarta às 18h, todas as semanas do mês (recorrente). Pede que a atendente deixe tudo marcado de uma vez."),
 ("pilates", "Digita com erros de português e abreviações (vc, tbm, qro). Quer a turma das 19h na quinta, mas pergunta antes se ainda tem vaga."),
]
SYS = ("Você simula um CLIENTE brasileiro conversando por WhatsApp com a atendente de um negócio. Escreva SÓ a próxima mensagem do cliente: curta, informal, 1 ou 2 frases, sem aspas. "
       "Objetivo e jeito do cliente: {goal} "
       "Se a atendente disser que o pedido foi registrado, agradeça de forma curta e na mensagem seguinte responda exatamente FIM. Se a conversa travar ou passar de 7 mensagens, responda FIM. Nunca revele que é uma simulação.")

def key():
    r = subprocess.run(["npx", "convex", "env", "get", "OPENROUTER_API_KEY"], cwd=R.cx.__globals__["WT"], capture_output=True, text=True)
    return r.stdout.strip()

def llm(k, system, history, model):
    body = {"model": model, "messages": [{"role": "system", "content": system}] + history, "max_tokens": 120, "temperature": 0.8, "usage": {"include": True}, "reasoning": {"enabled": False}}
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=json.dumps(body).encode(), headers={"Authorization": f"Bearer {k}", "Content-Type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=60))
    return d["choices"][0]["message"]["content"].strip(), float(d.get("usage", {}).get("cost", 0) or 0)

def one(i, org, goal, ctx, k, model, tag, cust_model):
    cv = Cv(ctx, org, f"FREE-{org}-{i}", idx=i + 11); hist = []; cost = 0.0
    msg, c = llm(k, SYS.format(goal=goal) + " Comece a conversa com a primeira mensagem.", [{"role": "user", "content": "Escreva a primeira mensagem do cliente."}], cust_model); cost += c
    for turn in range(7):
        if msg.strip().upper().startswith("FIM"): break
        t = cv.say(msg); hist += [{"role": "assistant", "content": msg}, {"role": "user", "content": "Atendente: " + "\n".join(t["ai"]) if t["ai"] else "Atendente: (sem resposta)"}]
        if t["handoffs"] and not t["ai"]: break
        msg, c = llm(k, SYS.format(goal=goal), hist, cust_model); cost += c
    s = dict(id=f"FREE-{org}", org=org, sit="L", desc="cliente livre: " + goal[:80], appts="any", handoff="any", reps=1, mode="propose", pair=False, max_appts=None)
    dump = cx("simAgendaRead:internalSimOrgDump", {"organizationId": ctx["orgs"][org]["organizationId"]})
    fails, review, obs = R.verify([cv], s, ctx, dump, "propose")
    summ = R.summarize([cv]); summ["customer_llm_cost_usd"] = round(cost, 5)
    row = dict(id=f"FREE-{org}#{i}", scenario=f"FREE-{org}", rep=i, org=org, situation="L", desc=s["desc"], mode="propose", model=model, tag=tag, passed=not fails, fails=fails, review=review, obs=obs, **summ, error=None)
    os.makedirs(os.path.join(ROOT, "transcricoes", tag), exist_ok=True)
    json.dump(dict(row=row, convs=[dict(name=cv.name, goal=goal, turns=[{kk: t[kk] for kk in ("sent", "ai", "verdict", "elapsed_ms", "new_offers", "appointments", "handoffs", "runs_new")} for t in cv.turns])]), open(os.path.join(ROOT, "transcricoes", tag, f"FREE-{org}_{i}.json"), "w"), ensure_ascii=False, indent=1, default=str)
    open(os.path.join(ROOT, f"resultados-{tag}.jsonl"), "a").write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
    print(row["id"], "OK" if row["passed"] else "FALHA", [f["kind"] for f in fails], "custo IA", summ["cost_usd"], "cliente", summ["customer_llm_cost_usd"], flush=True)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--tag", default="livre"); ap.add_argument("--suffix", default=""); ap.add_argument("--model", default="deepseek-flash-latest"); ap.add_argument("--cust", default="deepseek/deepseek-v4-flash"); ap.add_argument("--n", type=int, default=12)
    a = ap.parse_args(); ctx = R.load_ctx(a.suffix); k = key()
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(lambda x: one(x[0], x[1][0], x[1][1], ctx, k, a.model, a.tag, a.cust), list(enumerate(GOALS))[:a.n]))
