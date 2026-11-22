import json, subprocess, os, re, time
WT = os.environ.get("AGENDA_SIM_REPO", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))  # checkout com o .env.local do DEV
def cx(fn, args=None, retries=2, timeout=300):
    """Roda `npx convex run` no DEV (sem --prod) e devolve o JSON. Nunca imprime a chave."""
    last = None
    for i in range(retries + 1):
        r = subprocess.run(["npx", "convex", "run", fn, json.dumps(args or {}, ensure_ascii=False)], cwd=WT, capture_output=True, text=True, timeout=timeout)
        out = r.stdout.strip()
        if r.returncode == 0 and not out: return None
        if r.returncode == 0 and out:
            # a saída pode ter linhas de log antes do JSON; pega do primeiro { ou [ ou valor simples
            for start in [m.start() for m in re.finditer(r"^[\[{\"]|^-?\d|^null|^true|^false", out, re.M)]:
                try: return json.loads(out[start:])
                except Exception: continue
            try: return json.loads(out)
            except Exception: last = out[-500:]
        else:
            last = (r.stdout + r.stderr)[-800:]
        time.sleep(2)
    raise RuntimeError(f"convex run {fn} falhou: {last}")
