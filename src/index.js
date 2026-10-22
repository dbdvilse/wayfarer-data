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


// ---------------------------------------------------------------------------------------------------------------------
// Friends (item 174). Friend codes, no chat, no locations. Taking part is a choice; the player is only a SHA-256 hash of a random per-install key
// (a different salt from the Realm's Call, so the two cannot be joined). A profile (the hero's display name, class, race, level and season score) is
// shown only to people the player has accepted, or who have asked to be their friend by code (so they can decide). Adding someone by code sends a request;
// nobody sees a name just by knowing or guessing a code. "Leave" deletes everything stored for the player. See docs/FRIENDS.md.

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE = /^[A-Z2-9]{8}$/;
const NAME = /^[\p{L}\p{N} '’.\-]{1,40}$/u;
const SHORT = /^[A-Za-z0-9 \-]{1,20}$/;
const MAX_FRIENDS = 50;
const MAX_ADDS_PER_DAY = 20;
const MAX_REPORTS_PER_DAY = 10;

async function friendOf(key) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("wayfarer-friends:" + key));
  return [...new Uint8Array(bytes)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

function cleanProfile(p) {
  if (!isObject(p)) return null;
  if (typeof p.name !== "string" || !NAME.test(p.name.trim())) return null;
  if (typeof p.cls !== "string" || !SHORT.test(p.cls) || typeof p.race !== "string" || !SHORT.test(p.race)) return null;
  if (!Number.isInteger(p.level) || p.level < 1 || p.level > 100) return null;
  if (!Number.isInteger(p.score) || p.score < 0 || p.score > 1e9) return null;
  return { name: p.name.trim(), cls: p.cls, race: p.race, level: p.level, score: p.score };
}

// Everyone the player is connected to, with what each may see.
async function friendList(env, me) {
  const rows = await env.DB.prepare(
    "SELECT f.requester AS requester, f.status AS status, p.code AS code, p.name AS name, p.cls AS cls, p.race AS race, p.level AS level, p.score AS score " +
    "FROM friendships f JOIN friend_profiles p ON p.player = CASE WHEN f.requester = ?1 THEN f.target ELSE f.requester END " +
    "WHERE (f.requester = ?1 OR f.target = ?1) " +
    "AND NOT EXISTS (SELECT 1 FROM friend_blocks b WHERE (b.blocker = ?1 AND b.blocked = p.player) OR (b.blocker = p.player AND b.blocked = ?1))"
  ).bind(me).all();
  return (rows.results || []).map((r) => {
    if (r.status === "accepted") return { status: "friend", code: r.code, name: r.name, cls: r.cls, race: r.race, level: r.level, score: r.score };
    if (r.requester === me) return { status: "outgoing", code: r.code }; // asked by code: no name until they accept
    return { status: "incoming", code: r.code, name: r.name, cls: r.cls, race: r.race, level: r.level, score: r.score };
  });
}

async function other(env, code) {
  if (typeof code !== "string") return null;
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!CODE.test(c)) return null;
  return await env.DB.prepare("SELECT player, code FROM friend_profiles WHERE code = ?1").bind(c).first();
}

async function friends(request, env, url) {
  if (!env.DB) return reply(503);
  if (request.method !== "POST") return reply(405);
  const body = await readBody(request);
  if (!body || typeof body.key !== "string" || !KEY.test(body.key)) return reply(400);
  const me = await friendOf(body.key);
  const path = url.pathname;
  const day = new Date().toISOString().slice(0, 10);

  if (path === "/api/friends/leave") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM friendships WHERE requester = ?1 OR target = ?1").bind(me),
      env.DB.prepare("DELETE FROM friend_blocks WHERE blocker = ?1 OR blocked = ?1").bind(me),
      env.DB.prepare("DELETE FROM friend_reports WHERE reporter = ?1").bind(me),
      env.DB.prepare("DELETE FROM friend_limits WHERE player = ?1").bind(me),
      env.DB.prepare("DELETE FROM friend_profiles WHERE player = ?1").bind(me),
    ]);
    return reply(204);
  }

  if (path === "/api/friends/sync") {
    const profile = cleanProfile(body.profile);
    let mine = await env.DB.prepare("SELECT code FROM friend_profiles WHERE player = ?1").bind(me).first();
    if (!mine) {
      if (!profile) return json(400, { error: "a profile is needed to join" });
      for (let attempt = 0; attempt < 6 && !mine; attempt++) {
        const code = newCode();
        const result = await env.DB.prepare("INSERT OR IGNORE INTO friend_profiles (player, code, name, cls, race, level, score, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
          .bind(me, code, profile.name, profile.cls, profile.race, profile.level, profile.score, day).run();
        if (result.meta && result.meta.changes > 0) mine = { code };
      }
      if (!mine) return reply(503);
    } else if (profile) {
      await env.DB.prepare("UPDATE friend_profiles SET name = ?2, cls = ?3, race = ?4, level = ?5, score = ?6, updated = ?7 WHERE player = ?1")
        .bind(me, profile.name, profile.cls, profile.race, profile.level, profile.score, day).run();
    }
    return json(200, { code: mine.code, friends: await friendList(env, me) });
  }

  // Everything below needs the player to have joined.
  const self = await env.DB.prepare("SELECT code FROM friend_profiles WHERE player = ?1").bind(me).first();
  if (!self) return json(409, { error: "join first" });
  const target = await other(env, body.code);
  if (!target || target.player === me) return json(404, { error: "no one has that code" });
  const blocked = await env.DB.prepare("SELECT 1 AS x FROM friend_blocks WHERE (blocker = ?1 AND blocked = ?2) OR (blocker = ?2 AND blocked = ?1)").bind(me, target.player).first();

  if (path === "/api/friends/add") {
    if (blocked) return json(404, { error: "no one has that code" }); // (a block is never revealed)
    const limit = await env.DB.prepare("SELECT n FROM friend_limits WHERE player = ?1 AND day = ?2 AND kind = 'add'").bind(me, day).first();
    if (limit && limit.n >= MAX_ADDS_PER_DAY) return json(429, { error: "too many requests today" });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM friendships WHERE (requester = ?1 OR target = ?1) AND status = 'accepted'").bind(me).first();
    if (count && count.n >= MAX_FRIENDS) return json(409, { error: "your friends list is full" });
    await env.DB.prepare("INSERT INTO friend_limits (player, day, kind, n) VALUES (?1, ?2, 'add', 1) ON CONFLICT (player, day, kind) DO UPDATE SET n = friend_limits.n + 1").bind(me, day).run();
    const existing = await env.DB.prepare("SELECT requester, status FROM friendships WHERE (requester = ?1 AND target = ?2) OR (requester = ?2 AND target = ?1)").bind(me, target.player).first();
    if (existing) {
      if (existing.status === "pending" && existing.requester !== me) {
        // they had already asked: both sides want it
        await env.DB.prepare("UPDATE friendships SET status = 'accepted' WHERE requester = ?2 AND target = ?1").bind(me, target.player).run();
        return json(200, { status: "friend" });
      }
      return json(200, { status: existing.status === "accepted" ? "friend" : "outgoing" });
    }
    await env.DB.prepare("INSERT INTO friendships (requester, target, status, created) VALUES (?1, ?2, 'pending', ?3)").bind(me, target.player, day).run();
    return json(200, { status: "outgoing" });
  }

  if (path === "/api/friends/accept") {
    if (blocked) return json(404, { error: "no one has that code" });
    const result = await env.DB.prepare("UPDATE friendships SET status = 'accepted' WHERE requester = ?2 AND target = ?1 AND status = 'pending'").bind(me, target.player).run();
    return (result.meta && result.meta.changes > 0) ? json(200, { status: "friend" }) : json(404, { error: "no request from that code" });
  }

  if (path === "/api/friends/remove") {
    await env.DB.prepare("DELETE FROM friendships WHERE (requester = ?1 AND target = ?2) OR (requester = ?2 AND target = ?1)").bind(me, target.player).run();
    return reply(204);
  }

  if (path === "/api/friends/block") {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO friend_blocks (blocker, blocked) VALUES (?1, ?2)").bind(me, target.player),
      env.DB.prepare("DELETE FROM friendships WHERE (requester = ?1 AND target = ?2) OR (requester = ?2 AND target = ?1)").bind(me, target.player),
    ]);
    return reply(204);
  }

  if (path === "/api/friends/report") {
    const reason = typeof body.reason === "string" && SHORT.test(body.reason) ? body.reason : "other";
    const limit = await env.DB.prepare("SELECT n FROM friend_limits WHERE player = ?1 AND day = ?2 AND kind = 'report'").bind(me, day).first();
    if (limit && limit.n >= MAX_REPORTS_PER_DAY) return json(429, { error: "too many reports today" });
    const profile = await env.DB.prepare("SELECT name FROM friend_profiles WHERE player = ?1").bind(target.player).first();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO friend_limits (player, day, kind, n) VALUES (?1, ?2, 'report', 1) ON CONFLICT (player, day, kind) DO UPDATE SET n = friend_limits.n + 1").bind(me, day),
      env.DB.prepare("INSERT INTO friend_reports (reporter, reported, code, name, reason, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(me, target.player, target.code, profile ? profile.name : "", reason, day),
    ]);
    return reply(204);
  }
  return reply(404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/call" || url.pathname.startsWith("/api/call/")) return realmCall(request, env, url);
    if (url.pathname.startsWith("/api/friends/")) return friends(request, env, url);
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
