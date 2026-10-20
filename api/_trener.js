// Sdílený kód AI trenéra (podtržítko na začátku = Vercel z toho nedělá samostatnou adresu).
//
// Env proměnné na Vercelu:
//   ANTHROPIC_API_KEY  (povinné) – API klíč z console.anthropic.com
//   TRENER_HESLO       (doporučené) – heslo, aby ti cizí lidé neprojídali kredit
//   TRENER_MODEL       (volitelné) – výchozí claude-opus-5-5 (levnější: claude-sonnet-5-5)
//   TRENER_WEB         (volitelné) – "0" vypne vyhledávání na webu
//   TRENER_HRAC        (pro automatiku) – tvoje account ID, jehož zápasy se rozebírají samy
//   TRENER_MAX_DENNE   (volitelné) – max. automatických rozborů za den, výchozí 5
//   KV_REST_API_URL / KV_REST_API_TOKEN – přidá Vercel sám po připojení Upstash Redis

const OD = "https://api.opendota.com/api";
const STEAM64 = 76561197960265728n;
const ROLE = { 1: "safe lane (carry)", 2: "mid", 3: "offlane", 4: "jungle" };

// ------------------------------------------------------------ OpenDota

async function odGet(path) {
  const r = await fetch(OD + path, { headers: { "User-Agent": "dota2-souhrn" } });
  if (r.status === 404) { const e = new Error("Zápas nenalezen. Zkontroluj číslo zápasu."); e.code = 404; throw e; }
  if (!r.ok) throw new Error("OpenDota vrátila " + r.status);
  return r.json();
}

let konstanty = null; // cache mezi voláními téže instance
async function nactiKonstanty() {
  if (!konstanty) {
    const [heroes, items] = await Promise.all([odGet("/constants/heroes"), odGet("/constants/items")]);
    const itemById = {};
    for (const v of Object.values(items)) if (v && v.id != null) itemById[v.id] = v.dname || "";
    konstanty = { heroes, items, itemById };
  }
  return konstanty;
}

// ------------------------------------------------------------ pomocné

const cas = (s) => {
  s = Math.trunc(s);
  const z = s < 0 ? "-" : "";
  s = Math.abs(s);
  return `${z}${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const vMin = (rada, m) => (Array.isArray(rada) && rada.length > m ? rada[m] : null);
const jeRadiant = (p) => p.player_slot < 128;
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

function najdiHrace(zapas, heroes, hrac, hrdina) {
  if (hrac) {
    let id = BigInt(String(hrac).replace(/\D/g, "") || "0");
    if (id > STEAM64) id -= STEAM64;
    const p = zapas.players.find((p) => p.account_id != null && BigInt(p.account_id) === id);
    if (p) return p;
    if (!hrdina) throw new Error("Hráč s tímto ID v zápase není (nebo má skrytý profil). Zkus zadat hrdinu.");
  }
  if (hrdina) {
    const h = norm(hrdina);
    const p = zapas.players.find((p) => norm(heroes[p.hero_id]?.localized_name || "").includes(h));
    if (p) return p;
    throw new Error(`Hrdina „${hrdina}“ v zápase není.`);
  }
  throw new Error("Zadej ID hráče nebo hrdinu.");
}

// ------------------------------------------------------------ shrnutí

function shrnuti(zapas, ja, { heroes, items, itemById }) {
  const jm = (p) => heroes[p.hero_id]?.localized_name || "?";
  const mujNpc = heroes[ja.hero_id]?.name;
  const radiant = jeRadiant(ja);
  const vyhra = zapas.radiant_win === radiant;
  const rozparsovany = zapas.version != null;
  const d = {};

  d.zapas = {
    delka: cas(zapas.duration),
    vysledek: vyhra ? "VÝHRA" : "PROHRA",
    skore_muj_tym_vs_souper: radiant
      ? `${zapas.radiant_score}:${zapas.dire_score}` : `${zapas.dire_score}:${zapas.radiant_score}`,
    muj_tym: zapas.players.filter((p) => jeRadiant(p) === radiant).map(jm),
    souperi: zapas.players.filter((p) => jeRadiant(p) !== radiant).map(jm),
    replay_rozparsovany: rozparsovany,
  };

  d.hrac = {
    hrdina: jm(ja),
    role: ja.is_roaming ? "roaming" : ROLE[ja.lane_role] || "neznámá",
    KDA: `${ja.kills}/${ja.deaths}/${ja.assists}`,
    level: ja.level, last_hits: ja.last_hits, denies: ja.denies,
    GPM: ja.gold_per_min, XPM: ja.xp_per_min, net_worth: ja.net_worth,
    hero_damage: ja.hero_damage, tower_damage: ja.tower_damage, hero_healing: ja.hero_healing,
    ucast_v_teamfightech_pct: ja.teamfight_participation != null ? Math.round(100 * ja.teamfight_participation) : null,
    efektivita_lajny_pct: ja.lane_efficiency_pct ?? null,
    staky_campu: ja.camps_stacked ?? null,
    observer_wardy: ja.obs_placed ?? null, sentry_wardy: ja.sen_placed ?? null,
    stuny_sekund: ja.stuns ? Math.round(ja.stuns * 10) / 10 : null,
    APM: ja.actions_per_min ?? null,
    buybacky: (ja.buyback_log || []).map((b) => cas(b.time)),
  };

  if (ja.benchmarks) {
    d.percentil_vs_stejny_hrdina = {};
    for (const [k, v] of Object.entries(ja.benchmarks)) {
      if (v && v.pct != null)
        d.percentil_vs_stejny_hrdina[k] = `${Math.round(v.pct * 100)}. percentil (hodnota ${Math.round(v.raw * 100) / 100})`;
    }
  }

  const proti = { 1: 3, 3: 1, 2: 2 }[ja.lane_role];
  const soupers = zapas.players.filter((p) => jeRadiant(p) !== radiant && p.lane_role === proti);
  d.lajna = {};
  for (const m of [5, 10]) {
    const s = {};
    for (const p of soupers) s[jm(p)] = { LH: vMin(p.lh_t, m), zlato: vMin(p.gold_t, m) };
    d.lajna[`${m}min`] = { ja_LH: vMin(ja.lh_t, m), ja_DN: vMin(ja.dn_t, m), ja_zlato: vMin(ja.gold_t, m), souperi: s };
  }

  const nepratele = zapas.players.filter((p) => jeRadiant(p) !== radiant);
  d.zlato_v_case = {};
  for (let m = 10; m <= Math.floor(zapas.duration / 60); m += 5) {
    const moje = vMin(ja.gold_t, m);
    const jejich = nepratele.map((p) => vMin(p.gold_t, m)).filter((x) => x != null);
    if (moje != null && jejich.length)
      d.zlato_v_case[`${m}min`] = { ja: moje, prumer_nepratel: Math.round(jejich.reduce((a, b) => a + b, 0) / jejich.length) };
  }

  d.klicove_nakupy = (ja.purchase_log || [])
    .filter((n) => !n.key.startsWith("recipe_") && (items[n.key]?.cost || 0) >= 1000)
    .map((n) => `${cas(n.time)} ${items[n.key]?.dname || n.key}`);
  d.koupenych_TP = ja.purchase?.tpscroll ?? null;

  const fighty = zapas.teamfights || [];
  const smrti = [];
  for (const p of zapas.players)
    for (const k of p.kills_log || [])
      if (k.key === mujNpc) {
        const vTf = fighty.some((f) => f.start - 5 <= k.time && k.time <= f.end + 5);
        smrti.push([k.time, jm(p), vTf]);
      }
  smrti.sort((a, b) => a[0] - b[0]);
  d.smrti = smrti.map(([t, kdo, tf]) => `${cas(t)} zabil ${kdo}` + (tf ? " (během teamfightu)" : " (MIMO teamfight – pick-off)"));
  if (rozparsovany && ja.deaths - smrti.length > 0) d.smrti_ostatni = `${ja.deaths - smrti.length}× smrt od creepů/věží/neutrálů`;
  d.moje_killy_casy = (ja.kills_log || []).map((k) => cas(k.time));

  d.finalni_itemy = [0, 1, 2, 3, 4, 5].map((i) => itemById[ja[`item_${i}`]]).filter(Boolean);

  // teamfighty: kdy, jestli jsem byl u toho, kolik jsem dal damage, jestli jsem umřel
  const mujIdx = zapas.players.indexOf(ja);
  d.teamfighty = fighty.map((f) => {
    const t = (f.players || [])[mujIdx] || {};
    const ucast = (t.damage || 0) > 0 || (t.deaths || 0) > 0 || (t.healing || 0) > 0;
    return `${cas(f.start)}–${cas(f.end)}: padlo ${f.deaths} hrdinů; já: ${ucast
      ? `u toho, damage ${t.damage || 0}, killy ${Object.values(t.killed || {}).reduce((a, b) => a + b, 0)}, smrti ${t.deaths || 0}, zlato ${t.gold_delta >= 0 ? "+" : ""}${t.gold_delta || 0}`
      : "NEBYL JSEM U TOHO"}`;
  });

  // objektivy: věže, Roshan, first blood
  const muj = radiant ? 2 : 3;
  d.objektivy = (zapas.objectives || []).map((o) => {
    if (o.type === "building_kill" && /tower|barracks|rax|fort/.test(o.key || "")) {
      const nase = (o.key || "").includes(radiant ? "goodguys" : "badguys");
      const co = (o.key || "").replace(/npc_dota_(goodguys|badguys)_/, "");
      return `${cas(o.time)} padla ${nase ? "NAŠE" : "jejich"} budova ${co}`;
    }
    if (o.type === "CHAT_MESSAGE_ROSHAN_KILL") return `${cas(o.time)} Roshan – zabil ${o.team === muj ? "náš tým" : "soupeř"}`;
    if (o.type === "CHAT_MESSAGE_FIRSTBLOOD") return `${cas(o.time)} first blood`;
    return null;
  }).filter(Boolean);
  return d;
}

// ------------------------------------------------------------ Claude

const SYSTEM = `Jsi špičkový trenér Doty 2 (úroveň profesionálního analytika a coache).
Dostaneš data z jednoho zápasu hráče. Napiš česky konkrétní a upřímný rozbor v Markdownu.

Než začneš psát, můžeš použít webové vyhledávání (max. 3 hledání) a ověřit si aktuální
patch, doporučené buildy a tipy profesionálních hráčů pro hrdinu hráče a proti
soupeřům, které měl (např. Liquipedia, Dota 2 guidy, rozhovory a rady pro hráčů).
Zjištění zapracuj do rozboru, ale nevypisuj postup hledání.

Struktura:
## 1. Celkové hodnocení (2–3 věty, známka 1–10 za výkon v dané roli)
## 2. Co šlo dobře – konkrétně, s čísly a časy
## 3. Největší chyby – 3 až 5 nejdůležitějších podle dopadu; u každé: co se stalo (s časem), proč je to problém, co dělat příště
## 4. Build – byl rozumný vůči soupeřům a aktuálnímu patchi? Co by na jeho místě stavěli dobří hráči?
## 5. Na co se zaměřit – 1 až 3 konkrétní návyky do dalších her
## 6. Momenty k shlédnutí v replayi
Seznam 5–8 konkrétních časových úseků, seřazený podle času, ve formátu:
- **MM:SS–MM:SS** – co se tam stalo a na co se při sledování dívat (minimapa, pozice, kde byla vize, co měl soupeř)
Zahrň hlavně smrti mimo teamfight, teamfighty, kde hráč nebyl, prohrané/vyhrané klíčové fighty,
pomalá období farmy a momenty kolem padlých věží a Roshana. Okno začínej cca 20–30 s před událostí.

Pravidla: Čísla a časy ber jen z dat, nevymýšlej si situace, které z nich nevyplývají.
Nemáš pozice na mapě, takže u smrtí mluv o pravděpodobných příčinách, ne o jistotách.
Percentily jsou srovnání s ostatními hráči stejného hrdiny. Pokud replay není
rozparsovaný, některá data chybí – řekni to a hodnoť jen to, co máš.
Buď přímý jako dobrý trenér, ne zbytečně pochvalný, ale ani zlý. Max. ~1100 slov.`;

function claudeBody(data, stream) {
  return JSON.stringify({
    model: process.env.TRENER_MODEL || "claude-opus-5-5",
    max_tokens: 16000,
    stream,
    ...(process.env.TRENER_WEB === "0"
      ? {}
      : { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] }),
    system: SYSTEM,
    messages: [{ role: "user", content: "Data ze zápasu:\n\n" + JSON.stringify(data, null, 2) }],
  });
}

async function claudeFetch(data, stream) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: claudeBody(data, stream),
  });
  if (!r.ok) {
    const t = await r.text();
    let msg = t;
    try { msg = JSON.parse(t).error?.message || t; } catch {}
    if (r.status === 401) msg = "Neplatný API klíč (zkontroluj ANTHROPIC_API_KEY na Vercelu).";
    if (/credit balance/i.test(msg)) msg = "Na Anthropic účtu došel kredit – dobij ho v console.anthropic.com → Billing.";
    throw new Error("Claude API: " + msg);
  }
  return r;
}

// streamuje rozbor do odpovědi a vrací celý text
async function streamClaude(data, res) {
  const r = await claudeFetch(data, true);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", stop = null, text = "";
  const pis = (t) => { res.write(t); text += t; };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      if (ev.type === "content_block_start" && ev.content_block?.type === "text" && text) {
        pis("\n\n");
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        pis(ev.delta.text);
      } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
        stop = ev.delta.stop_reason;
      } else if (ev.type === "error") {
        throw new Error("Claude API: " + (ev.error?.message || "chyba při generování"));
      }
    }
  }
  if (stop === "max_tokens") res.write("\n\n_(Rozbor byl useknutý kvůli limitu délky.)_");
  if (!text) res.write(`\n\n⚠️ AI nevrátila žádný text (stop_reason: ${stop}).`);
  return { text, stop };
}

// bez streamování (pro automatické rozbory)
async function claudeText(data) {
  const r = await claudeFetch(data, false);
  const j = await r.json();
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
  return { text, stop: j.stop_reason };
}

// ------------------------------------------------------------ úložiště (Upstash Redis přes REST)

const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const maUloziste = () => Boolean(RURL && RTOK);

async function redis(...cmd) {
  const r = await fetch(RURL, {
    method: "POST",
    headers: { Authorization: `Bearer ${RTOK}`, "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error("Redis: " + j.error);
  return j.result;
}

const klicRozboru = (match, hrac, hrdina) =>
  `rozbor:${match}:${String(hrac || "").trim() || "h-" + String(hrdina || "").trim().toLowerCase()}`;

async function ulozRozbor(z) {
  if (!maUloziste()) return;
  const k = klicRozboru(z.match, z.hrac, z.hrdinaZadany);
  await redis("SET", k, JSON.stringify({ ...z, klic: k }));
  await redis("ZADD", "rozbory", String(z.hrano || Math.floor(Date.now() / 1000)), k);
  await redis("SREM", "trener:smazane", k);
}

async function seznamRozboru(limit = 200) {
  if (!maUloziste()) return null;
  const klice = await redis("ZREVRANGE", "rozbory", "0", String(limit - 1));
  if (!klice || !klice.length) return [];
  const hodnoty = await redis("MGET", ...klice);
  return hodnoty.map((v) => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
}

async function smazRozbor(k) {
  if (!maUloziste()) return;
  await redis("DEL", k);
  await redis("ZREM", "rozbory", k);
  await redis("SADD", "trener:smazane", k); // ať ho automatika znovu nerozebírá
}

async function smazane() {
  if (!maUloziste()) return new Set();
  return new Set((await redis("SMEMBERS", "trener:smazane")) || []);
}

const jeChybnyText = (t) => !t || t.trim().length < 300 || /^\s*⚠️/.test(t.trim());

module.exports = {
  OD, odGet, nactiKonstanty, najdiHrace, shrnuti, cas,
  streamClaude, claudeText,
  maUloziste, redis, klicRozboru, ulozRozbor, seznamRozboru, smazRozbor, smazane, jeChybnyText,
};
