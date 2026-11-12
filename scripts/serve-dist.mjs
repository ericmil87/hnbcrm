#!/usr/bin/env node
// Local static server for `dist/` that imitates how Vercel routes this project:
//   1. filesystem first (an existing file wins over any rewrite; `dir/` -> `dir/index.html`);
//   2. then the `rewrites` of vercel.json, in order (first match wins, anchored regex over the path);
//   3. otherwise 404.
// Serves the precompressed `.br`/`.gz` siblings when the client accepts them, so byte counts look
// like production. Dev tool only (prerender validation, Lighthouse); never used in the deploy.
//
// Usage: node scripts/serve-dist.mjs [--dir dist] [--port 4173] [--vercel vercel.json]
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, createReadStream } from "node:fs";
import { extname, join, resolve, normalize } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const root = resolve(opt("dir", "dist"));
const port = Number(opt("port", "4173"));
const vercel = JSON.parse(readFileSync(resolve(opt("vercel", "vercel.json")), "utf8"));
const rewrites = (vercel.rewrites ?? []).map((r) => ({ re: new RegExp(`^${r.source}$`), destination: r.destination }));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

/** Filesystem lookup with Vercel's directory index behavior; returns an absolute file path or null. */
function fileFor(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const abs = join(root, rel);
  if (!abs.startsWith(root)) return null;
  if (existsSync(abs) && statSync(abs).isFile()) return abs;
  const index = join(abs, "index.html");
  if (existsSync(index)) return index;
  return null;
}

function send(req, res, file, status = 200) {
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const accept = String(req.headers["accept-encoding"] ?? "");
  let body = file;
  const headers = { "Content-Type": type, "Cache-Control": "no-store" };
  if (accept.includes("br") && existsSync(`${file}.br`)) {
    body = `${file}.br`;
    headers["Content-Encoding"] = "br";
  } else if (accept.includes("gzip") && existsSync(`${file}.gz`)) {
    body = `${file}.gz`;
    headers["Content-Encoding"] = "gzip";
  }
  headers["Content-Length"] = statSync(body).size;
  res.writeHead(status, headers);
  createReadStream(body).pipe(res);
}

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const direct = fileFor(pathname);
  if (direct) return send(req, res, direct);
  for (const rw of rewrites) {
    if (!rw.re.test(pathname)) continue;
    const target = fileFor(rw.destination);
    if (target) return send(req, res, target);
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404");
}).listen(port, () => {
  console.log(`serving ${root} on http://localhost:${port} (filesystem first, then vercel.json rewrites)`);
});
