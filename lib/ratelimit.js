/* Limitador simples em memória (janela fixa). Suficiente para uma instância; com várias instâncias, use Redis/proxy. */
function limiter({ max, windowMs, message = "Muitas requisições. Tente novamente em instantes." }) {
  const hits = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (n > v.reset) hits.delete(k); }, 60e3).unref();
  const mw = (req, res, next) => {
    const n = Date.now(); let h = hits.get(req.ip);
    if (!h || n > h.reset) { h = { n: 0, reset: n + windowMs }; hits.set(req.ip, h); }
    if (++h.n > max) { res.set("Retry-After", String(Math.ceil((h.reset - n) / 1000))); return res.status(429).json({ error: message }); }
    next();
  };
  return mw;
}

/** Bloqueio progressivo para login: conta só as falhas, por IP. Zera no sucesso. */
function loginGuard({ max = 5, windowMs = 15 * 60e3 } = {}) {
  const f = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, v] of f) if (n > v.reset) f.delete(k); }, 60e3).unref();
  return {
    blocked(ip) { const v = f.get(ip); if (!v) return 0; if (Date.now() > v.reset) { f.delete(ip); return 0; } return v.n >= max ? Math.ceil((v.reset - Date.now()) / 1000) : 0; },
    fail(ip) {
      let v = f.get(ip);
      if (!v || Date.now() > v.reset) v = { n: 0, reset: Date.now() + windowMs };
      v.n++;
      f.set(ip, v);
    },
    ok(ip) { f.delete(ip); }
  };
}
module.exports = { limiter, loginGuard };
