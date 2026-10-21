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

async function odGet(path, pokusu = 3) {
  for (let i = 0; ; i++) {
    const r = await fetch(OD + path, { headers: { "User-Agent": "dota2-souhrn" } });
    if (r.status === 404) { const e = new Error("Nenalezeno na OpenDotě: " + path.split("?")[0]); e.code = 404; throw e; }
    if (r.ok) return r.json();
    // 429 = moc dotazů za minutu, 5xx = výpadek; chvíli počkat a zkusit znovu
    if ((r.status === 429 || r.status >= 500) && i < pokusu - 1) { await new Promise((ok) => setTimeout(ok, 2500 * (i + 1))); continue; }
    throw new Error("OpenDota vrátila " + r.status);
  }
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

// ------------------------------------------------------------ draft: hodnocení picku a alternativy

// jednoduchá cache v Redisu (když je k dispozici), ať se OpenDota nevolá pořád dokola
async function cached(key, ttlSec, fn) {
  if (maUloziste()) {
    try { const v = await redis("GET", key); if (v) return JSON.parse(v); } catch {}
  }
  const val = await fn();
  if (maUloziste()) { try { await redis("SET", key, JSON.stringify(val), "EX", String(ttlSec)); } catch {} }
  return val;
}

// matchupy hrdiny: { enemyId: {g, w} } + základní winrate napříč všemi matchupy
async function matchupy(heroId) {
  return cached(`cache:matchup:${heroId}`, 86400, async () => {
    const list = await odGet(`/heroes/${heroId}/matchups`);
    const m = {}; let G = 0, W = 0;
    for (const x of Array.isArray(list) ? list : []) {
      m[x.hero_id] = { g: x.games_played, w: x.wins }; G += x.games_played; W += x.wins;
    }
    return { m, base: G ? W / G : 0.5, games: G };
  });
}

// výhoda hrdiny proti soupeřům v procentních bodech (malé vzorky se tlumí)
function vyhoda(mu, enemyIds, jm) {
  const det = {}; let soucet = 0;
  for (const e of enemyIds) {
    const x = mu.m[e];
    if (!x || !x.g) { det[jm(e)] = "bez dat"; continue; }
    const raw = (x.w / x.g - mu.base) * 100;
    const v = raw * (x.g / (x.g + 30));
    soucet += v;
    det[jm(e)] = `${v >= 0 ? "+" : ""}${v.toFixed(1)} b. (${x.g} her)`;
  }
  return { det, soucet: Math.round(soucet * 10) / 10 };
}

async function draft(zapas, ja, { heroes }) {
  const jm = (id) => heroes[id]?.localized_name || "?";
  const radiant = ja.player_slot < 128;
  const enemyAll = zapas.players.filter((p) => (p.player_slot < 128) !== radiant).map((p) => p.hero_id);
  const d = { muj_pick: jm(ja.hero_id) };

  // pořadí picků (když ho OpenDota má): kteří soupeři byli vidět v době mého picku
  let enemyVidet = enemyAll;
  const pb = (zapas.picks_bans || []).filter((x) => x.is_pick).sort((a, b) => a.order - b.order);
  const muj = pb.find((x) => x.hero_id === ja.hero_id);
  if (muj) {
    const mujTym = muj.team;
    const predem = pb.filter((x) => x.order < muj.order);
    enemyVidet = predem.filter((x) => x.team !== mujTym).map((x) => x.hero_id);
    const poradiVTymu = predem.filter((x) => x.team === mujTym).length + 1;
    d.poradi_picku = `${poradiVTymu}. pick v týmu; soupeři vidět v době picku: ${enemyVidet.map(jm).join(", ") || "žádní"}; soupeři pickovaní až po mně: ${
      enemyAll.filter((h) => !enemyVidet.includes(h)).map(jm).join(", ") || "žádní"}`;
  } else {
    d.poradi_picku = "pořadí picků není k dispozici – hodnoceno proti všem 5 soupeřům";
  }

  // můj pick proti soupeřům
  const muMuj = await matchupy(ja.hero_id);
  const vsVse = vyhoda(muMuj, enemyAll, jm);
  const vsVidet = vyhoda(muMuj, enemyVidet, jm);
  d.muj_pick_matchupy = { proti_vsem_soupericum: vsVse.det, soucet_vyhody_vse: vsVse.soucet,
                          soucet_vyhody_proti_videnym: vsVidet.soucet };

  // můj hero pool (posledních 365 dní, stejná lajna)
  if (!ja.account_id) { d.alternativy = "hráč má skrytý profil – hero pool není k dispozici"; return d; }
  const lane = ja.lane_role ? `&lane_role=${ja.lane_role}` : "";
  let pool = await cached(`cache:pool:${ja.account_id}:${ja.lane_role || 0}`, 43200, () =>
    odGet(`/players/${ja.account_id}/heroes?date=365${lane}`));
  if (lane && !(pool || []).some((h) => h.games >= 8)) {
    // na téhle lajně skoro nehraje → vzít pool ze všech lajn (role core/support se filtruje níž)
    pool = await cached(`cache:pool:${ja.account_id}:0`, 43200, () => odGet(`/players/${ja.account_id}/heroes?date=365`));
    d.poznamka_k_poolu = "na téhle lajně hráč skoro nehraje, alternativy jsou z celého jeho poolu";
  }
  const muj_zaznam = (pool || []).find((h) => Number(h.hero_id) === ja.hero_id);
  d.moje_hry_na_picku = muj_zaznam && muj_zaznam.games
    ? `${muj_zaznam.games} her, ${Math.round((100 * muj_zaznam.win) / muj_zaznam.games)} % WR (posl. rok, tahle lajna)` : "na téhle lajně skoro nehraný";

  // core vs. support podle pořadí net worthu v týmu
  const tym = zapas.players.filter((p) => (p.player_slot < 128) === radiant)
    .sort((a, b) => (b.net_worth || 0) - (a.net_worth || 0));
  const jeSupport = tym.indexOf(ja) >= 3;
  const sedi = (id) => {
    const r = heroes[id]?.roles || [];
    return jeSupport ? r.includes("Support") : r[0] !== "Support";
  };
  const obsazeno = new Set(zapas.players.map((p) => p.hero_id));
  const kandidati = (pool || [])
    .filter((h) => h.games >= 8 && Number(h.hero_id) !== ja.hero_id && !obsazeno.has(Number(h.hero_id)) && sedi(Number(h.hero_id)))
    .sort((a, b) => b.games - a.games).slice(0, 14);

  const hodnoceni = await Promise.all(kandidati.map(async (h) => {
    const id = Number(h.hero_id);
    const v = vyhoda(await matchupy(id), enemyVidet, jm);
    const wr = h.win / h.games;
    const osobni = (wr - 0.5) * 100 * (h.games / (h.games + 20));
    return {
      hrdina: jm(id), role: (heroes[id]?.roles || []).slice(0, 3).join("/"),
      moje_hry: h.games, moje_wr: `${Math.round(wr * 100)} %`,
      vyhoda_proti_soupericum: v.soucet, detail: v.det,
      skore: Math.round((v.soucet + 0.5 * osobni) * 10) / 10,
    };
  }));
  hodnoceni.sort((a, b) => b.skore - a.skore);
  const mojeWr = muj_zaznam && muj_zaznam.games ? muj_zaznam.win / muj_zaznam.games : 0.5;
  const mojeOsobni = (mojeWr - 0.5) * 100 * ((muj_zaznam?.games || 0) / ((muj_zaznam?.games || 0) + 20));
  d.skore_meho_picku = Math.round((vsVidet.soucet + 0.5 * mojeOsobni) * 10) / 10;
  d.alternativy_z_meho_poolu = hodnoceni.slice(0, 6);
  d.vysvetlivky = "výhoda = o kolik procentních bodů má hrdina proti danému soupeři vyšší winrate než je jeho průměr (matchupy z OpenDoty, malé vzorky tlumené – ber orientačně); skóre = výhoda proti soupeřům viditelným při picku + polovina mé osobní výhody na hrdinovi";
  return d;
}

// ------------------------------------------------------------ hráč: rank, lajna, vlastní průměr, profík, paměť

const RANKY = ["", "Herald", "Guardian", "Crusader", "Archon", "Legend", "Ancient", "Divine", "Immortal"];
const zaokr = (x) => (Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 10) / 10);
const dnes = () => new Date().toISOString().slice(0, 10);

async function hracInfo(accountId) {
  if (!accountId) return null;
  return cached(`cache:hrac:${accountId}`, 86400, async () => {
    const p = await odGet(`/players/${accountId}`);
    const t = p.rank_tier || 0, tier = Math.floor(t / 10), hv = t % 10;
    return {
      rank: tier ? `${RANKY[tier] || "?"}${tier < 8 && hv ? " " + hv : ""}` : "neznámý",
      leaderboard: p.leaderboard_rank || null,
      bracket: tier || null,
    };
  });
}

// prvních 10 minut po minutách proti soupeři na lajně
function lajnaDetail(zapas, ja, heroes) {
  if (!Array.isArray(ja.gold_t) || ja.gold_t.length < 3) return null;
  const jm = (p) => heroes[p.hero_id]?.localized_name || "?";
  const radiant = jeRadiant(ja);
  const proti = { 1: 3, 3: 1, 2: 2 }[ja.lane_role];
  const soup = zapas.players.filter((p) => jeRadiant(p) !== radiant && p.lane_role === proti);
  const spol = zapas.players.filter((p) => p !== ja && jeRadiant(p) === radiant && p.lane_role === ja.lane_role);
  const mujNpc = heroes[ja.hero_id]?.name;

  const minuty = [];
  let pred = null, zvrat = null;
  for (let m = 1; m <= 10; m++) {
    const mz = vMin(ja.gold_t, m);
    if (mz == null) break;
    const sz = soup.map((p) => vMin(p.gold_t, m)).filter((x) => x != null);
    const diff = sz.length ? mz - Math.max(...sz) : null; // proti nejbohatšímu soupeři na lajně
    minuty.push({
      min: m, LH: vMin(ja.lh_t, m), DN: vMin(ja.dn_t, m), zlato: mz, XP: vMin(ja.xp_t, m),
      souper_LH: soup.map((p) => vMin(p.lh_t, m)), rozdil_zlata_vs_souper: diff,
    });
    if (diff != null && pred != null && (!zvrat || Math.abs(diff - pred) > Math.abs(zvrat.zmena))) zvrat = { min: m, zmena: diff - pred };
    pred = diff;
  }
  const smrti = [];
  for (const p of zapas.players)
    for (const k of p.kills_log || []) if (k.key === mujNpc && k.time <= 600) smrti.push(`${cas(k.time)} (zabil ${jm(p)})`);
  const zabil = (ja.kills_log || []).filter((k) => k.time <= 600).map((k) => cas(k.time));
  const konec = minuty[minuty.length - 1];
  return {
    souperi_na_lajne: soup.map(jm), spoluhraci_na_lajne: spol.map(jm),
    po_minutach: minuty,
    vysledek_lajny_10min: konec?.rozdil_zlata_vs_souper == null ? "nelze určit"
      : konec.rozdil_zlata_vs_souper > 400 ? "vyhraná" : konec.rozdil_zlata_vs_souper < -400 ? "prohraná" : "vyrovnaná",
    nejvetsi_zvrat: zvrat ? `${zvrat.min}. minuta: rozdíl zlata se změnil o ${zvrat.zmena > 0 ? "+" : ""}${zvrat.zmena}` : null,
    smrti_do_10min: smrti.sort(), killy_do_10min: zabil,
    efektivita_lajny_pct: ja.lane_efficiency_pct ?? null,
  };
}

// tenhle zápas proti mým posledním 20 hrám na stejném hrdinovi
async function mujPrumer(zapas, ja) {
  if (!ja.account_id) return null;
  const pole = ["kills", "deaths", "assists", "gold_per_min", "xp_per_min", "last_hits", "hero_damage", "duration", "radiant_win", "player_slot"];
  const q = pole.map((x) => `project=${x}`).join("&");
  const list = await cached(`cache:hist:${ja.account_id}:${ja.hero_id}`, 3600, () =>
    odGet(`/players/${ja.account_id}/matches?hero_id=${ja.hero_id}&limit=25&${q}`));
  const ostatni = (Array.isArray(list) ? list : [])
    .filter((z) => String(z.match_id) !== String(zapas.match_id) && (z.duration || 0) >= 600).slice(0, 20);
  if (ostatni.length < 3) return { pocet_her: ostatni.length, poznamka: "na hrdinovi málo her na srovnání" };

  const metr = {
    GPM: (z) => z.gold_per_min, XPM: (z) => z.xp_per_min,
    "LH/min": (z) => z.last_hits / (z.duration / 60),
    "hero damage/min": (z) => z.hero_damage / (z.duration / 60),
    smrti: (z) => z.deaths,
    KDA: (z) => (z.kills + z.assists) / Math.max(1, z.deaths),
  };
  const ted = { ...ja, duration: zapas.duration };
  const out = {};
  for (const [n, f] of Object.entries(metr)) {
    const h = ostatni.map(f).filter(Number.isFinite);
    const t = f(ted);
    if (h.length < 3 || !Number.isFinite(t)) continue;
    const vse = [...h, t].sort((a, b) => (n === "smrti" ? a - b : b - a));
    const prum = h.reduce((a, b) => a + b, 0) / h.length;
    out[n] = `${zaokr(t)} – ${vse.indexOf(t) + 1}. nejlepší z ${vse.length} (tvůj průměr ${zaokr(prum)})`;
  }
  const vyhry = ostatni.filter((z) => (z.player_slot < 128) === z.radiant_win).length;
  return {
    pocet_her: ostatni.length,
    winrate_poslednich_her: `${Math.round((100 * vyhry) / ostatni.length)} %`,
    tento_zapas: out,
  };
}

// nedávný profesionální zápas na stejném hrdinovi (ideálně stejná lajna)
async function profik(ja, k) {
  return cached(`cache:pro:${ja.hero_id}:${ja.lane_role || 0}`, 21600, async () => {
    const list = await odGet(`/heroes/${ja.hero_id}/matches`);
    let vybrany = null;
    for (const z of (Array.isArray(list) ? list : []).slice(0, 4)) {
      let m;
      try { m = await odGet(`/matches/${z.match_id}`); } catch { continue; }
      const p = (m.players || []).find((x) => x.hero_id === ja.hero_id);
      if (!p || m.version == null) continue;
      const shoda = !ja.lane_role || p.lane_role === ja.lane_role;
      if (!vybrany || (shoda && !vybrany.shoda)) vybrany = { m, p, shoda };
      if (shoda) break;
    }
    if (!vybrany) return null;
    const { m, p } = vybrany;
    return {
      hrac: p.name || p.personaname || "profík", liga: m.league?.name || null,
      datum: new Date(m.start_time * 1000).toISOString().slice(0, 10), match_id: m.match_id,
      vysledek: (p.player_slot < 128) === m.radiant_win ? "výhra" : "prohra", delka: cas(m.duration),
      role: ROLE[p.lane_role] || "?", KDA: `${p.kills}/${p.deaths}/${p.assists}`,
      GPM: p.gold_per_min, XPM: p.xp_per_min,
      LH_10min: vMin(p.lh_t, 10), zlato_10min: vMin(p.gold_t, 10), zlato_20min: vMin(p.gold_t, 20),
      klicove_nakupy: (p.purchase_log || [])
        .filter((n) => !n.key.startsWith("recipe_") && (k.items[n.key]?.cost || 0) >= 1000)
        .slice(0, 8).map((n) => `${cas(n.time)} ${k.items[n.key]?.dname || n.key}`),
      finalni_itemy: [0, 1, 2, 3, 4, 5].map((i) => k.itemById[p[`item_${i}`]]).filter(Boolean),
    };
  });
}

// paměť trenéra: shrnutí předchozích rozborů
async function pamet(hrac, matchId) {
  if (!maUloziste() || !hrac) return null;
  const list = (await seznamRozboru(60))
    .filter((z) => String(z.hrac) === String(hrac) && String(z.match) !== String(matchId) && z.hodnoceni)
    .sort((a, b) => (b.hrano || 0) - (a.hrano || 0));
  if (!list.length) return null;
  const pocty = {};
  for (const z of list.slice(0, 20)) for (const s of z.hodnoceni.stitky_chyb || []) pocty[s.stitek] = (pocty[s.stitek] || 0) + 1;
  return {
    posledni_rozbory: list.slice(0, 8).map((z) => ({
      datum: z.hrano ? new Date(z.hrano * 1000).toISOString().slice(0, 10) : null,
      hrdina: z.hrdina, vysledek: z.vysledek, znamka: z.hodnoceni.celkem,
      chyby: (z.hodnoceni.stitky_chyb || []).map((s) => s.stitek),
      cil: z.hodnoceni.cil_na_dalsi_hru || null,
    })),
    nejcastejsi_chyby_poslednich_20: Object.entries(pocty).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s, n]) => `${s} (${n}×)`),
    cil_z_minule_hry: list[0].hodnoceni.cil_na_dalsi_hru || null,
  };
}

// ------------------------------------------------------------ znalostní báze a nastavení

async function znalosti(heroId) {
  if (!maUloziste()) return null;
  const v = await redis("GET", `znalosti:${heroId}`);
  return v ? JSON.parse(v) : null;
}
async function ulozZnalosti(heroId, zmeny) {
  const n = { ...((await znalosti(heroId)) || {}), ...zmeny };
  await redis("SET", `znalosti:${heroId}`, JSON.stringify(n));
  return n;
}
async function nastaveni() {
  const zakl = { autoGuide: true, guideStariDni: 21 };
  if (!maUloziste()) return zakl;
  try { return { ...zakl, ...JSON.parse((await redis("GET", "nastaveni")) || "{}") }; } catch { return zakl; }
}
async function ulozNastaveni(zmeny) {
  const n = { ...(await nastaveni()), ...zmeny };
  await redis("SET", "nastaveni", JSON.stringify(n));
  return n;
}
const guideJeStary = (zn, dni) => !zn?.guide || !zn.guide_datum || Date.now() - new Date(zn.guide_datum).getTime() > dni * 86400000;

// ------------------------------------------------------------ příprava dat pro rozbor

async function pripravData(zapas, ja, k) {
  const data = shrnuti(zapas, ja, k);
  const bezpecne = (p) => p.catch((e) => ({ chyba: e.message }));
  const [dr, info, prum, pro, pam, zn] = await Promise.all([
    bezpecne(draft(zapas, ja, k)),
    bezpecne(hracInfo(ja.account_id)),
    bezpecne(mujPrumer(zapas, ja)),
    bezpecne(profik(ja, k)),
    bezpecne(pamet(ja.account_id, zapas.match_id)),
    bezpecne(znalosti(ja.hero_id)),
  ]);
  data.hrac_uroven = info;
  data.draft = dr;
  data.lajna_detail = lajnaDetail(zapas, ja, k.heroes);
  data.srovnani_s_mym_prumerem = prum;
  data.srovnani_s_profikem = pro;
  data.pamet_trenera = pam;
  if (zn && !zn.chyba && (zn.poznamky || zn.guide)) {
    data.znalosti_o_hrdinovi = {
      moje_poznamky: zn.poznamky || null,
      aktualni_guide: zn.guide ? `(${zn.guide_datum?.slice(0, 10)}) ${zn.guide}` : null,
    };
  }
  return data;
}

// ------------------------------------------------------------ Claude

const MODEL = () => process.env.TRENER_MODEL || "claude-opus-5-5";
const MODEL_LEVNY = () => process.env.TRENER_MODEL_KONTROLA || "claude-sonnet-5-5";
const webTool = (n) => (process.env.TRENER_WEB === "0" ? {} : { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: n }] });

const SYSTEM = `Jsi špičkový trenér Doty 2 (úroveň profesionálního analytika a coache).
Dostaneš data z jednoho zápasu hráče. Napiš česky konkrétní a upřímný rozbor v Markdownu.

KALIBRACE: Úroveň hráče je v "hrac_uroven" (rank). Rady přizpůsob jí – u Divine/Immortal
vynech základy (kupuj wardy, last hituj), jdi do detailů: timingy, rozhodování, pozicování,
čtení mapy, power spiky. U nižších ranků můžeš být základnější.

PODKLADY: Než začneš psát, můžeš použít webové vyhledávání (max. 3 hledání) k ověření
aktuálního patche, buildů a rad pro hráčů. Pokud je v datech "znalosti_o_hrdinovi", ber
hráčovy poznámky a uložený guide jako důležitý kontext (guide může být starší než patch).
Postup hledání nevypisuj.

Struktura:
## 1. Celkové hodnocení
2–3 věty, známka 1–10 za výkon v dané roli.
## 2. Pick – hodnocení 1–10 a co jiného picknout
Ohodnoť pick vůči soupeřům (data "draft"). Zohledni, kteří soupeři byli vidět v době picku –
za counter-pick, který přišel až po hráči, nemůže. Doporuč 2–3 alternativy POUZE z jeho
hero poolu ("alternativy_z_meho_poolu"), u každé jednou větou proč. Čísla ber orientačně.
## 3. Lajna (0–10 min)
Z "lajna_detail": kdo lajnu vyhrál, kdy se zlomila (nejvetsi_zvrat), CS a zlato proti soupeři
po minutách (stačí klíčové minuty), smrti a killy na lajně a co měl hráč udělat jinak.
## 4. Co šlo dobře – konkrétně, s čísly a časy
## 5. Největší chyby – 3 až 5 podle dopadu; u každé: co se stalo (s časem), proč je to problém, co dělat příště
## 6. Build a timingy
Byl build rozumný vůči soupeřům a patchi? Porovnej timingy klíčových itemů s profíkem
("srovnani_s_profikem" – uveď jméno a že jde o jeden konkrétní zápas, ne pravidlo).
Pokud se hodí přehledné srovnání, použij Markdown tabulku.
## 7. Oproti tvým minulým hrám
Z "srovnani_s_mym_prumerem": byl tenhle zápas na hrdinovi nadprůměrný, nebo podprůměrný
(např. „3. nejhorší GPM z posledních 20“). Z "pamet_trenera": opakují se stejné chyby? Splnil
hráč cíl z minulé hry ("cil_z_minule_hry")? Pokud paměť chybí, tuhle část zkrať.
## 8. Na co se zaměřit
1–3 konkrétní návyky a na konec jeden měřitelný **Cíl na další hru**.
## 9. Momenty k shlédnutí v replayi
Seznam 5–8 časových úseků seřazených podle času, ve formátu:
- **MM:SS–MM:SS** – co se tam stalo a na co se dívat (minimapa, pozice, vize, co měl soupeř)
Zahrň smrti mimo teamfight, teamfighty bez hráče, klíčové fighty, pomalou farmu, věže a Roshana.
Okno začínej cca 20–30 s před událostí.

Pravidla: Čísla, časy a jména ber jen z dat, nevymýšlej si situace, které z nich nevyplývají.
Délku zápasu ber výhradně z "zapas.delka". V textu nikdy nezmiňuj technické názvy polí z dat
(např. alternativy_z_meho_poolu) – piš normální češtinou („z tvého hero poolu“).
Nemáš pozice na mapě, takže u smrtí mluv o pravděpodobných příčinách. Pokud replay není
rozparsovaný nebo nějaká data chybí, řekni to a hodnoť jen to, co máš.
Buď přímý jako dobrý trenér, ne zbytečně pochvalný, ale ani zlý. Max. ~1600 slov.`;

function rozborBody(data, stream) {
  return {
    model: MODEL(), max_tokens: 16000, stream, ...webTool(3), system: SYSTEM,
    messages: [{ role: "user", content: "Data ze zápasu:\n\n" + JSON.stringify(data, null, 2) }],
  };
}

async function claudeFetch(body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
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

// streamuje text do odpovědi a vrací ho celý
async function streamText(body, res) {
  const r = await claudeFetch({ ...body, stream: true });
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
      if (ev.type === "content_block_start" && ev.content_block?.type === "text" && text) pis("\n\n");
      else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") pis(ev.delta.text);
      else if (ev.type === "message_delta" && ev.delta?.stop_reason) stop = ev.delta.stop_reason;
      else if (ev.type === "error") throw new Error("Claude API: " + (ev.error?.message || "chyba při generování"));
    }
  }
  if (stop === "max_tokens") res.write("\n\n_(Text byl useknutý kvůli limitu délky.)_");
  if (!text) res.write(`\n\n⚠️ AI nevrátila žádný text (stop_reason: ${stop}).`);
  return { text, stop };
}

async function textOnce(body) {
  const r = await claudeFetch({ ...body, stream: false });
  const j = await r.json();
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
  return { text, stop: j.stop_reason };
}

// stavový řádek pro stránku (stránka ho nezobrazí v textu, jen jako stav)
const stavRadek = (res, msg) => res.write(`\u001d${msg}\n`);

// ------------------------------------------------------------ guide k hrdinovi (AI hledá na webu)

const GUIDE_SYSTEM = `Jsi analytik Doty 2. Pomocí webového vyhledávání najdi NEJAKTUÁLNĚJŠÍ kvalitní guidy
a buildy pro zadaného hrdinu (aktuální patch; preferuj zdroje jako Liquipedia, aktuální
high-MMR/pro buildy, guidy profesionálních hráčů a coachů, oficiální patch notes).
Shrň je česky v Markdownu, max. ~450 slov:
## Patch a role (pro jaký patch guide platí, na jaké pozice se hrdina hraje)
## Skill build a talenty
## Itemy (start, early, core, situační – vždy s podmínkou KDY který)
## Lajna a timingy (power spiky, kdy farmit/bojovat)
## Mid a late game
## Dobré a špatné matchupy
## Zdroje (názvy a odkazy, ze kterých jsi čerpal)
Nevypisuj postup hledání. Pokud si něčím nejsi jistý, napiš to.`;

const guideBody = (heroName) => ({
  model: MODEL(), max_tokens: 6000, ...webTool(5), system: GUIDE_SYSTEM,
  messages: [{ role: "user", content: `Hrdina: ${heroName}. Dnešní datum: ${dnes()}.` }],
});

// ------------------------------------------------------------ kontrola faktů + strukturované hodnocení

const STITKY = [
  "smrt mimo teamfight", "smrt bez vize", "smrt po buybacku", "slabá lajna", "pomalá farma",
  "pozdní klíčový item", "chybí BKB/defenzivní item", "build nesedí na soupeře", "chybí v teamfightu",
  "nevyužitý náskok", "slabý tlak na objektivy", "špatný pick", "málo wardů", "zbytečný buyback",
  "nízký damage", "pozdní rotace", "riskantní farma", "jiné",
];
const KATEGORIE = ["celkem", "pick", "lajna", "farma", "teamfighty", "pozicovani", "build"];

const KONTROLA_SYSTEM = `Jsi pečlivý kontrolor faktů a analytik Doty 2. Dostaneš DATA zápasu (JSON) a ROZBOR od trenéra.

Úkol 1 – kontrola faktů: najdi v rozboru tvrzení, která jsou v jasném rozporu s daty
(špatná čísla, časy, jména hrdinů nebo itemů, vymyšlené události, které z dat nevyplývají).
Vždy zkontroluj hlavně délku zápasu (zapas.delka), výsledek, KDA a časy smrtí.
Pro každé uveď "puvodni" = DOSLOVNÝ úryvek z rozboru (krátký, přesně zkopírovaný, aby šel
automaticky nahradit) a "nove" = opravené znění. Neopravuj styl ani názory, jen fakta.
Webové informace o patchi a buildech (nejsou v datech) neopravuj.

Úkol 2 – strukturované hodnocení podle rozboru a dat: známky 1–10 pro kategorie
${KATEGORIE.join(", ")}; štítky chyb POUZE z tohoto seznamu: ${STITKY.join("; ")};
krátké silné stránky; jeden konkrétní měřitelný cíl na další hru.

Vrať POUZE JSON, bez dalšího textu a bez Markdownu:
{"opravy":[{"puvodni":"...","nove":"..."}],
 "hodnoceni":{"celkem":7,"pick":6,"lajna":8,"farma":7,"teamfighty":5,"pozicovani":4,"build":6,
  "stitky_chyb":[{"stitek":"smrt mimo teamfight","cas":"36:48","popis":"krátce"}],
  "silne_stranky":["krátce"],"cil_na_dalsi_hru":"..."}}`;

function parseJson(t) {
  if (!t) return null;
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const bezDiakritiky = (x) => String(x).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z_]/g, "");
const cislo = (v) => { const m = String(v ?? "").replace(",", ".").match(/\d+(\.\d+)?/); return m ? Number(m[0]) : NaN; };

function normalizujHodnoceni(h) {
  if (!h || typeof h !== "object") return null;
  // klíče bez diakritiky a velkých písmen („Pozicování“ → pozicovani), hodnoty i jako „8/10“
  const n = {};
  for (const [k, v] of Object.entries(h)) n[bezDiakritiky(k)] = v;
  const out = {};
  for (const k of KATEGORIE) {
    const v = Math.round(cislo(n[k]));
    if (Number.isFinite(v)) out[k] = Math.min(10, Math.max(1, v));
  }
  const stitky = Array.isArray(n.stitky_chyb) ? n.stitky_chyb : Array.isArray(n.stitky) ? n.stitky : [];
  out.stitky_chyb = stitky.slice(0, 8).map((s) => {
    const nazev = typeof s === "string" ? s : s?.stitek;
    const shoda = STITKY.find((x) => bezDiakritiky(x) === bezDiakritiky(nazev || ""));
    return { stitek: shoda || "jiné", cas: typeof s?.cas === "string" ? s.cas : null, popis: String(s?.popis || (shoda ? "" : nazev || "")).slice(0, 200) };
  });
  out.silne_stranky = (Array.isArray(n.silne_stranky) ? n.silne_stranky : []).slice(0, 5).map((x) => String(x).slice(0, 200));
  out.cil_na_dalsi_hru = n.cil_na_dalsi_hru ? String(n.cil_na_dalsi_hru).slice(0, 300) : null;
  if (!out.celkem) {
    // celková známka chybí → průměr ostatních
    const ost = KATEGORIE.filter((k) => out[k]).map((k) => out[k]);
    if (ost.length >= 3) out.celkem = Math.round(ost.reduce((a, b) => a + b, 0) / ost.length);
  }
  return out.celkem ? out : null;
}

const HODNOCENI_SYSTEM = `Jsi analytik Doty 2. Podle DAT zápasu a ROZBORU vrať POUZE JSON (bez dalšího textu):
{"celkem":7,"pick":6,"lajna":8,"farma":7,"teamfighty":5,"pozicovani":4,"build":6,
 "stitky_chyb":[{"stitek":"...","cas":"MM:SS","popis":"krátce"}],"silne_stranky":["..."],"cil_na_dalsi_hru":"..."}
Známky jsou celá čísla 1–10. Štítky POUZE z tohoto seznamu: ${STITKY.join("; ")}.`;

async function kontrola(data, text) {
  const zadani = `DATA:\n${JSON.stringify(data)}\n\nROZBOR:\n${text}`;
  const { text: out } = await textOnce({
    model: MODEL_LEVNY(), max_tokens: 8000, system: KONTROLA_SYSTEM,
    messages: [{ role: "user", content: zadani }],
  });
  const j = parseJson(out);
  let finalni = text, opravy = 0;
  for (const o of Array.isArray(j?.opravy) ? j.opravy : []) {
    if (o?.puvodni && typeof o.nove === "string" && o.puvodni.length >= 3 && finalni.includes(o.puvodni)) {
      finalni = finalni.replace(o.puvodni, o.nove);
      opravy++;
    }
  }
  let hodnoceni = normalizujHodnoceni(j?.hodnoceni || (j && j.celkem ? j : null));
  if (!hodnoceni) {
    // druhý pokus: jen hodnocení, kratší úkol
    try {
      const { text: out2 } = await textOnce({
        model: MODEL_LEVNY(), max_tokens: 3000, system: HODNOCENI_SYSTEM,
        messages: [{ role: "user", content: `DATA:\n${JSON.stringify(data)}\n\nROZBOR:\n${finalni}` }],
      });
      const j2 = parseJson(out2);
      hodnoceni = normalizujHodnoceni(j2?.hodnoceni || j2);
    } catch { /* necháme bez hodnocení */ }
  }
  return {
    text: finalni, opravy, hodnoceni,
    chybaKontroly: !j ? "odpověď kontroly se nepodařilo přečíst" : !hodnoceni ? "nepodařilo se vytvořit hodnocení" : null,
  };
}

// celý rozbor: text (streamovaně nebo naráz) + kontrola + hodnocení
async function rozebrat(data, res) {
  const { text } = res ? await streamText(rozborBody(data), res) : await textOnce(rozborBody(data));
  if (jeChybnyText(text)) return { text, hodnoceni: null, opravy: 0 };
  if (res) stavRadek(res, "Kontroluji fakta a ukládám hodnocení…");
  try { return await kontrola(data, text); }
  catch (e) { return { text, hodnoceni: null, opravy: 0, chybaKontroly: e.message }; }
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

// záznam rozboru ze zápasu a připravených dat
const zaznam = (zapas, data, vysledek, extra) => ({
  match: String(zapas.match_id), hrdina: data.hrac.hrdina,
  vysledek: data.zapas.vysledek + " · " + data.zapas.delka,
  souperi: data.zapas.souperi, hrano: zapas.start_time, datum: new Date().toISOString(),
  text: vysledek.text, hodnoceni: vysledek.hodnoceni || null, ...extra,
});

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
  OD, ROLE, odGet, nactiKonstanty, najdiHrace, shrnuti, pripravData, cas, cached, matchupy, hracInfo, dnes,
  streamText, textOnce, stavRadek, rozebrat, guideBody, MODEL, MODEL_LEVNY, webTool,
  znalosti, ulozZnalosti, nastaveni, ulozNastaveni, guideJeStary, STITKY, KATEGORIE, normalizujHodnoceni,
  maUloziste, redis, klicRozboru, ulozRozbor, zaznam, seznamRozboru, smazRozbor, smazane, jeChybnyText,
};
