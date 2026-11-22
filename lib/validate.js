/* Validações de entrada. Tudo que vem de fora passa por aqui. */
const PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com",
  ...(process.env.PUSH_ENDPOINT_ALLOW || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean)];

const isLocal = h => h === "localhost" || h === "127.0.0.1" || h === "[::1]";

/** Normaliza uma origem (https://host[:porta]). http só é aceito para localhost. Retorna null se inválida. */
function normOrigin(v) {
  if (typeof v !== "string" || v.length > 200) return null;
  let u; try { u = new URL(v.trim()); } catch { return null; }
  if (u.username || u.password) return null;
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal(u.hostname))) return null;
  return u.origin;
}

function parseOrigins(list) {
  if (!Array.isArray(list) || !list.length || list.length > 10) return null;
  const out = [...new Set(list.map(normOrigin))];
  return out.includes(null) ? null : out;
}

/** Destino do clique: http(s), sem credenciais, tamanho limitado. */
function parseTargetUrl(v) {
  if (typeof v !== "string" || v.length > 2000 || /\s/.test(v)) return null;
  let u; try { u = new URL(v); } catch { return null; }
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || !u.hostname.includes(".") && !isLocal(u.hostname)) return null;
  return u;
}

/** Link precisa pertencer ao site (host igual ou subdomínio de alguma origem cadastrada), salvo se o site permitir links externos. */
function urlBelongsToSite(u, origins) {
  return origins.some(o => { const h = new URL(o).hostname; return u.hostname === h || u.hostname.endsWith("." + h); });
}

function validSubscription(s) {
  if (!s || typeof s !== "object" || typeof s.endpoint !== "string" || s.endpoint.length > 1000) return "Inscrição inválida.";
  let u; try { u = new URL(s.endpoint); } catch { return "Inscrição inválida."; }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.port || u.username || u.password || !PUSH_HOSTS.some(p => h === p || h.endsWith("." + p)))
    return "Serviço de push não reconhecido.";   // evita que o servidor seja induzido a chamar endereços arbitrários (SSRF)
  const k = s.keys;
  if (!k || typeof k.p256dh !== "string" || typeof k.auth !== "string") return "Inscrição inválida.";
  if (!/^[A-Za-z0-9_-]+$/.test(k.p256dh) || !/^[A-Za-z0-9_-]+$/.test(k.auth)) return "Chaves inválidas.";
  const p = Buffer.from(k.p256dh, "base64url"), a = Buffer.from(k.auth, "base64url");
  if (p.length !== 65 || p[0] !== 4 || a.length !== 16) return "Chaves inválidas.";
  return null;
}

/** Rótulo genérico do dispositivo a partir do User-Agent. O UA completo não é armazenado. */
function deviceLabel(ua = "") {
  const b = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /Firefox\//.test(ua) ? "Firefox" : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const o = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux|X11/.test(ua) ? "Linux" : null;
  return b || o ? [b, o].filter(Boolean).join(" · ") : null;
}

/** Imagem real? Confere os bytes (não só o prefixo informado). */
function imageType(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

module.exports = { normOrigin, parseOrigins, parseTargetUrl, urlBelongsToSite, validSubscription, deviceLabel, imageType, clean };
