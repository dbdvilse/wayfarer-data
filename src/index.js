// Wayfarer play statistics (item 149): receives batches of anonymous play log lines from phones whose players agreed to share them.
// Static files (the game data) are served by Cloudflare directly and never reach this code: only /api/* runs it (see wrangler.jsonc).
//
// Privacy by construction: every line is rebuilt here from an allow-list of game fields (the phone already did the same), the time is cut to the
// hour, and nothing about the sender is stored: no IP address, no user agent, no id. The batch id is random per batch and only stops a retry
// from being stored twice. See docs/PLAY-LOG.md and docs/PRIVACY.md in the game repository.

const MAX_BODY = 140000;      // bytes
const MAX_LINES = 200;
const WORD = /^[A-Za-z0-9_ :.\-]{1,80}$/;
const BATCH_ID = /^[A-Za-z0-9\-]{8,64}$/;
const EVENTS = ["fight", "level", "shop"];
const TEXTS = ["v", "where", "outcome", "killedBy", "class", "race", "launcher", "mode", "kind", "item"];
const NUMBERS = ["area", "turns", "kills", "dealt", "taken", "xp", "from", "to", "qty", "gold", "level", "maxHp", "ac", "blows", "melee"];
const FLAGS = ["ambush", "boss"];
const COUNTS = ["monsters", "spells", "shots", "items"];
const HERO_TEXTS = ["class", "race", "launcher", "mode"];
const HERO_NUMBERS = ["level", "maxHp", "ac", "blows", "melee"];

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const text = (o, k) => (typeof o[k] === "string" && WORD.test(o[k]) ? o[k] : undefined);
const number = (o, k) =>
  typeof o[k] === "number" && Number.isFinite(o[k]) && o[k] >= -1e9 && o[k] <= 1e12 ? Math.round(o[k] * 10) / 10 : undefined;

// The same rules as PlayLogPrivacy.Clean in the game (sim/src/Wayfarer.Rules/PlayLog/PlayLogUpload.cs).
export function clean(line) {
  if (!isObject(line) || !EVENTS.includes(line.e)) return null;
  const o = { e: line.e };
  if (typeof line.t === "string" && /^\d{4}-\d\d-\d\dT\d\d/.test(line.t)) o.t = line.t.slice(0, 13) + ":00:00Z";
  for (const k of TEXTS) { const v = text(line, k); if (v !== undefined) o[k] = v; }
  for (const k of NUMBERS) { const v = number(line, k); if (v !== undefined) o[k] = v; }
  for (const k of FLAGS) if (typeof line[k] === "boolean") o[k] = line[k];
  for (const k of COUNTS) {
    if (!isObject(line[k])) continue;
    const counts = {};
    let n = 0;
    for (const [name, value] of Object.entries(line[k])) {
      if (n++ >= 40) break;
      if (WORD.test(name) && typeof value === "number" && value >= 0 && value <= 100000) counts[name] = Math.round(value);
    }
    if (Object.keys(counts).length > 0) o[k] = counts;
  }
  if (isObject(line.hero)) {
    const hero = {};
    for (const k of HERO_TEXTS) { const v = text(line.hero, k); if (v !== undefined) hero[k] = v; }
    for (const k of HERO_NUMBERS) { const v = number(line.hero, k); if (v !== undefined) hero[k] = v; }
    if (Object.keys(hero).length > 0) o.hero = hero;
  }
  return Object.keys(o).length <= 2 ? null : o;
}

const reply = (status, body = null) => new Response(body, { status, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/stats") return reply(404);
    if (request.method !== "POST") return reply(405);
    if (!env.DB) return reply(503);

    const length = Number(request.headers.get("content-length") || "0");
    if (length > MAX_BODY) return reply(413);
    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply(413);

    let body;
    try { body = JSON.parse(raw); } catch { return reply(400); }
    if (!isObject(body) || body.schema !== 1 || typeof body.batch !== "string" || !BATCH_ID.test(body.batch) || !Array.isArray(body.lines))
      return reply(400);
    const lines = body.lines.slice(0, MAX_LINES).map(clean).filter((l) => l !== null);
    if (lines.length === 0) return reply(400);

    // The received time is cut to the hour as well.
    const received = new Date().toISOString().slice(0, 13) + ":00:00Z";
    const statements = lines.map((l, i) =>
      env.DB.prepare("INSERT OR IGNORE INTO lines (batch, n, received, line) VALUES (?1, ?2, ?3, ?4)").bind(body.batch, i, received, JSON.stringify(l)));
    await env.DB.batch(statements);
    return reply(204);
  },
};
