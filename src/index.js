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


// ---------------------------------------------------------------------------------------------------------------------
// The Realm's Call (item 173): one shared goal for all players for a set time. Reading the current call needs no identity. Contributing, checking
// your share, claiming the reward and leaving use a random per-install key made on the phone: only its SHA-256 is stored, and "leave" deletes
// everything stored under it. No names, no locations, no IP addresses. Calls are put in the `calls` table by the owner (see docs/REALM-CALL.md).

const KEY = /^[0-9a-f]{32}$/;
const CALL_ID = /^[A-Za-z0-9_\-]{1,40}$/;
const MAX_KILLS_PER_POST = 500;

const json = (status, body, cache = "no-store") =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": cache } });

async function playerOf(key) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("wayfarer-call:" + key));
  return [...new Uint8Array(bytes)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const callJson = (r) => ({
  id: r.id, title: r.title, story: r.story, family: r.family, goal: r.goal, total: r.total,
  startsUtc: r.starts, endsUtc: r.ends, rewardGold: r.reward_gold, rewardTitle: r.reward_title, minKills: r.min_kills, dailyCap: r.daily_cap,
});

async function readBody(request) {
  const length = Number(request.headers.get("content-length") || "0");
  if (length > 2000) return null;
  const raw = await request.text();
  if (raw.length > 2000) return null;
  try { const b = JSON.parse(raw); return isObject(b) ? b : null; } catch { return null; }
}

async function mine(env, call, player) {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(kills), 0) AS kills FROM call_days WHERE call = ?1 AND player = ?2").bind(call, player).first();
  return r ? r.kills : 0;
}

async function realmCall(request, env, url) {
  if (!env.DB) return reply(503);
  const now = new Date().toISOString().slice(0, 19) + "Z";
  const path = url.pathname;

  // The current call: the latest one that has started (so a finished one can still be seen and its reward claimed).
  if (path === "/api/call") {
    if (request.method !== "GET") return reply(405);
    const row = await env.DB.prepare("SELECT * FROM calls WHERE starts <= ?1 ORDER BY starts DESC LIMIT 1").bind(now).first();
    return row ? json(200, callJson(row), "public, max-age=20") : json(404, {});
  }
  if (request.method !== "POST") return reply(405);
  const body = await readBody(request);
  if (!body || typeof body.key !== "string" || !KEY.test(body.key)) return reply(400);
  const player = await playerOf(body.key);

  if (path === "/api/call/leave") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM call_days WHERE player = ?1").bind(player),
      env.DB.prepare("DELETE FROM call_claims WHERE player = ?1").bind(player),
    ]);
    return reply(204);
  }

  if (typeof body.call !== "string" || !CALL_ID.test(body.call)) return reply(400);
  const call = await env.DB.prepare("SELECT * FROM calls WHERE id = ?1").bind(body.call).first();
  if (!call) return json(404, {});

  if (path === "/api/call/me") {
    const claimed = await env.DB.prepare("SELECT 1 AS x FROM call_claims WHERE call = ?1 AND player = ?2").bind(call.id, player).first();
    return json(200, { total: call.total, mine: await mine(env, call.id, player), claimed: !!claimed });
  }

  if (path === "/api/call/contribute") {
    const kills = body.kills;
    if (!Number.isInteger(kills) || kills < 1 || kills > MAX_KILLS_PER_POST) return reply(400);
    const open = call.starts <= now && now < call.ends && call.total < call.goal;
    let added = 0;
    if (open) {
      const day = now.slice(0, 10);
      const used = await env.DB.prepare("SELECT kills FROM call_days WHERE call = ?1 AND player = ?2 AND day = ?3").bind(call.id, player, day).first();
      added = Math.max(0, Math.min(kills, call.daily_cap - (used ? used.kills : 0), call.goal - call.total));
      if (added > 0) {
        await env.DB.batch([
          env.DB.prepare("INSERT INTO call_days (call, player, day, kills) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (call, player, day) DO UPDATE SET kills = call_days.kills + excluded.kills")
            .bind(call.id, player, day, added),
          env.DB.prepare("UPDATE calls SET total = total + ?1 WHERE id = ?2").bind(added, call.id),
        ]);
      }
    }
    const fresh = await env.DB.prepare("SELECT total, goal FROM calls WHERE id = ?1").bind(call.id).first();
    return json(200, { total: fresh.total, done: fresh.total >= fresh.goal, added, mine: await mine(env, call.id, player) });
  }

  if (path === "/api/call/claim") {
    if (call.total < call.goal) return json(409, { error: "the call is not met yet" });
    const kills = await mine(env, call.id, player);
    if (kills < call.min_kills) return json(403, { error: "not enough kills to share the reward", mine: kills, minKills: call.min_kills });
    const result = await env.DB.prepare("INSERT OR IGNORE INTO call_claims (call, player) VALUES (?1, ?2)").bind(call.id, player).run();
    const already = !(result.meta && result.meta.changes > 0);
    return json(200, { rewardGold: call.reward_gold, rewardTitle: call.reward_title, already });
  }
  return reply(404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/call" || url.pathname.startsWith("/api/call/")) return realmCall(request, env, url);
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
