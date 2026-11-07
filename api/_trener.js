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
//   STRATZ_TOKEN       (doporučené) – matchupy a srovnání s Divine+ hráči (stratz.com/api)

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
  // co náš tým ztratil do 90 s po smrti (budovy, Roshan) – pro odhad dopadu chyby
  const nasStr = radiant ? "goodguys" : "badguys", mujTymId = radiant ? 2 : 3;
  const ztraty = (t) => (zapas.objectives || []).filter((o) => o.time > t && o.time <= t + 90).map((o) => {
    if (o.type === "building_kill" && (o.key || "").includes(nasStr)) return `padla naše ${(o.key || "").replace(/npc_dota_(goodguys|badguys)_/, "")}`;
    if (o.type === "CHAT_MESSAGE_ROSHAN_KILL" && o.team && o.team !== mujTymId) return "soupeř vzal Roshana";
    return null;
  }).filter(Boolean);
  d.smrti = smrti.map(([t, kdo, tf]) => {
    const z = ztraty(t);
    return `${cas(t)} zabil ${kdo}` + (tf ? " (během teamfightu)" : " (MIMO teamfight – pick-off)") + (z.length ? ` → do 90 s: ${z.join(", ")}` : "");
  });
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

// matchupy jen z her Divine+ (STRATZ, potřebuje STRATZ_TOKEN); při chybě null → použije se OpenDota
const DIVINE_PLUS = [7, 8];
async function matchupyDivine(heroId) {
  if (!process.env.STRATZ_TOKEN) return null;
  try {
    return await cached(`cache:matchup_divine:${heroId}`, 86400, async () => {
      const r = await fetch("https://api.stratz.com/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.STRATZ_TOKEN, "User-Agent": "STRATZ_API" },
        body: JSON.stringify({
          query: `query M($heroId: Short!, $brackets: [RankBracketBasicEnum]) { heroStats { matchUp(heroId: $heroId, bracketBasicIds: $brackets, take: 200) { heroId vs { heroId2 matchCount winCount } } } }`,
          variables: { heroId: Number(heroId), brackets: ["DIVINE_IMMORTAL"] },
        }),
      });
      if (!r.ok) throw new Error("STRATZ " + r.status);
      const j = await r.json();
      if (j.errors) throw new Error("STRATZ GraphQL chyba");
      const mu = j.data?.heroStats?.matchUp;
      const entry = Array.isArray(mu) ? (mu.find((e) => e && e.heroId === Number(heroId)) || mu[0]) : mu;
      const m = {}; let G = 0, W = 0;
      for (const v of entry?.vs || []) {
        if (v?.heroId2 == null || !v.matchCount) continue;
        m[v.heroId2] = { g: v.matchCount, w: v.winCount || 0 }; G += v.matchCount; W += v.winCount || 0;
      }
      if (!G) throw new Error("STRATZ bez dat");
      return { m, base: W / G, games: G, zdroj: "STRATZ Divine+" };
    });
  } catch { return null; }
}
const matchupyPick = async (heroId) => (await matchupyDivine(heroId)) || (await matchupy(heroId));

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

// statistiky hrdinů z veřejných zápasů (winrate a počet picků podle ranku)
async function heroStats() {
  return cached("cache:herostats", 43200, () => odGet("/heroStats"));
}

// meta v daném ranku: { heroId: {wr, pick} } (bracket 1–8 = Herald…Immortal; bez ranku = všechny)
function metaVRanku(hs, bracket) {
  const out = {};
  for (const h of Array.isArray(hs) ? hs : []) {
    let p = 0, w = 0;
    const br = Array.isArray(bracket) ? bracket : bracket ? [bracket] : [1, 2, 3, 4, 5, 6, 7, 8];
    for (const b of br) { p += h[`${b}_pick`] || 0; w += h[`${b}_win`] || 0; }
    if (p) out[h.id] = { wr: w / p, pick: p };
  }
  return out;
}

const omez = (x, a, b) => Math.min(b, Math.max(a, x));
// body skóre → známka 1–10 (0 bodů = průměrný, rozumný pick = 6)
const znamkaZeSkore = (sk) => omez(Math.round(6 + sk / 2.5), 1, 10);

// kolik procent her hraje hrdina na které lajně (OpenDota scenarios/laneRoles, posl. týdny)
const LAJNA_JMENO = { 1: "safe lane (carry)", 2: "mid", 3: "offlane" };
async function podilLajn() {
  return cached("cache:laneroles", 86400, async () => {
    const out = {};
    for (const lane of [1, 2, 3]) {
      const rows = await odGet(`/scenarios/laneRoles?lane_role=${lane}`);
      for (const r of Array.isArray(rows) ? rows : []) {
        const h = (out[r.hero_id] = out[r.hero_id] || { 1: 0, 2: 0, 3: 0 });
        h[lane] += Number(r.games) || 0;
      }
    }
    return out;
  });
}
// sedí hrdina na lajnu? podle podílu her (≥ 20 %), bez dat podle rolí hrdiny
function sediNaLajnu(id, lane, podil, heroes) {
  if (!lane || lane > 3) return true;
  const p = podil && podil[id];
  if (p) { const sum = p[1] + p[2] + p[3]; if (sum >= 200) return p[lane] / sum >= 0.2; }
  const r = heroes[id]?.roles || [];
  return lane === 1 ? r.includes("Carry") : lane === 2 ? r.includes("Nuker") || r.includes("Carry") : r.includes("Initiator") || r.includes("Durable");
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
  const enemyPozdeji = enemyAll.filter((h) => !enemyVidet.includes(h));

  // můj pick proti soupeřům + meta v mém ranku
  const [muMuj, hs, info] = await Promise.all([
    matchupyPick(ja.hero_id), heroStats().catch(() => null), hracInfo(ja.account_id).catch(() => null),
  ]);
  // winrate hrdiny vždy z her Divine+ (Divine + Immortal), bez ohledu na rank hráče
  const meta = metaVRanku(hs, DIVINE_PLUS);
  const metaBody = (id) => (meta[id] ? (meta[id].wr - 0.5) * 100 : 0);
  const metaText = (id) => (meta[id] ? `${(meta[id].wr * 100).toFixed(1)} %` : "bez dat");
  const vsVse = vyhoda(muMuj, enemyAll, jm);
  const vsVidet = vyhoda(muMuj, enemyVidet, jm);
  const vsPozdeji = vyhoda(muMuj, enemyPozdeji, jm);
  d.muj_pick_matchupy = { proti_vsem_soupericum: vsVse.det, soucet_vyhody_vse: vsVse.soucet,
                          soucet_vyhody_proti_videnym: vsVidet.soucet };
  if (enemyPozdeji.length && vsPozdeji.soucet <= -3)
    d.counterpick_po_mne = `soupeř mě po picku counteroval (${enemyPozdeji.map(jm).join(", ")}: ${vsPozdeji.soucet} b.) – za to hráč nemůže`;

  // můj hero pool (posledních 365 dní, stejná lajna)
  let pool = [], muj_zaznam = null;
  if (ja.account_id) {
    const lane = ja.lane_role ? `&lane_role=${ja.lane_role}` : "";
    pool = await cached(`cache:pool:${ja.account_id}:${ja.lane_role || 0}`, 43200, () =>
      odGet(`/players/${ja.account_id}/heroes?date=365${lane}`)).catch(() => []);
    if (lane && !(pool || []).some((h) => h.games >= 8)) {
      // na téhle lajně skoro nehraje → vzít pool ze všech lajn (role core/support se filtruje níž)
      pool = await cached(`cache:pool:${ja.account_id}:0`, 43200, () => odGet(`/players/${ja.account_id}/heroes?date=365`)).catch(() => []);
      d.poznamka_k_poolu = `na téhle lajně (${LAJNA_JMENO[ja.lane_role] || "?"}) hráč skoro nehraje – alternativy jsou z celého poolu, ale jen hrdinové, kteří se na tuhle lajnu běžně hrají`;
    }
    pool = Array.isArray(pool) ? pool : [];
    muj_zaznam = pool.find((h) => Number(h.hero_id) === ja.hero_id);
    d.moje_hry_na_picku = muj_zaznam && muj_zaznam.games
      ? `${muj_zaznam.games} her, ${Math.round((100 * muj_zaznam.win) / muj_zaznam.games)} % WR (posl. rok, tahle lajna)` : "na téhle lajně skoro nehraný";
  }
  const osobniBody = (z) => (z && z.games ? (z.win / z.games - 0.5) * 100 * (z.games / (z.games + 20)) : 0);

  // skóre = výhoda proti viditelným soupeřům + meta winrate Divine+ + polovina osobní výhody
  const mojeOsobni = osobniBody(muj_zaznam);
  const mojeSkore = vsVidet.soucet + metaBody(ja.hero_id) + 0.5 * mojeOsobni;
  d.skore_meho_picku = Math.round(mojeSkore * 10) / 10;
  d.pick_znamka_z_dat = znamkaZeSkore(mojeSkore);
  d.pick_rozpad = {
    proti_videnym_souperum: `${vsVidet.soucet >= 0 ? "+" : ""}${vsVidet.soucet} b.`,
    meta_divine_plus: meta[ja.hero_id] ? `${metaText(ja.hero_id)} WR (Divine+)` : "bez dat",
    zdroj_matchupu: muMuj.zdroj || "OpenDota (všechny ranky)",
    osobni_komfort: muj_zaznam ? `${muj_zaznam.games} her, ${Math.round((100 * muj_zaznam.win) / muj_zaznam.games)} % WR` : "bez dat",
  };

  if (!ja.account_id) { d.alternativy = "hráč má skrytý profil – hero pool není k dispozici"; return d; }

  // core vs. support podle pořadí net worthu v týmu
  const tym = zapas.players.filter((p) => (p.player_slot < 128) === radiant)
    .sort((a, b) => (b.net_worth || 0) - (a.net_worth || 0));
  const jeSupport = tym.indexOf(ja) >= 3;
  const podil = await podilLajn().catch(() => null);
  // support: hrdina se hraje jako support; core: hrdina se běžně hraje na mojí lajně
  const sedi = (id) => {
    const r = heroes[id]?.roles || [];
    return jeSupport ? r.includes("Support") : r[0] !== "Support" && sediNaLajnu(id, ja.lane_role, podil, heroes);
  };
  const rolePopis = jeSupport ? "support" : LAJNA_JMENO[ja.lane_role] || "core";
  d.moje_role_v_zapase = rolePopis;
  const obsazeno = new Set(zapas.players.map((p) => p.hero_id));
  const kandidati = pool
    .filter((h) => h.games >= 8 && Number(h.hero_id) !== ja.hero_id && !obsazeno.has(Number(h.hero_id)) && sedi(Number(h.hero_id)))
    .sort((a, b) => b.games - a.games).slice(0, 14);

  // v poolu nic pro tuhle roli → nabídnout silné hrdiny pro roli z mety Divine+ (k naučení)
  if (kandidati.length < 2) {
    d.poznamka_k_poolu = `v hero poolu nemáš (skoro) žádné hrdiny pro roli ${rolePopis} – alternativy z poolu nedávají smysl`;
    const maxPick = Math.max(1, ...Object.values(meta).map((m) => m.pick));
    const kNauceni = Object.entries(meta)
      .map(([id, m]) => ({ id: Number(id), m }))
      .filter(({ id, m }) => m.pick > maxPick * 0.15 && id !== ja.hero_id && !obsazeno.has(id) && sedi(id))
      .sort((a, b) => b.m.wr - a.m.wr).slice(0, 10);
    const hodK = await Promise.all(kNauceni.map(async ({ id }) => {
      const v = vyhoda(await matchupyPick(id), enemyVidet, jm);
      const sk = v.soucet + metaBody(id);
      return { hrdina: jm(id), meta_wr: metaText(id), vyhoda_proti_soupericum: v.soucet, skore: Math.round(sk * 10) / 10, znamka: znamkaZeSkore(sk) };
    }));
    d.k_nauceni_pro_tuhle_roli = hodK.sort((a, b) => b.skore - a.skore).slice(0, 4);
  }

  const hodnoceni = await Promise.all(kandidati.map(async (h) => {
    const id = Number(h.hero_id);
    const v = vyhoda(await matchupyPick(id), enemyVidet, jm);
    const sk = v.soucet + metaBody(id) + 0.5 * osobniBody(h);
    return {
      hrdina: jm(id), role: (heroes[id]?.roles || []).slice(0, 3).join("/"),
      moje_hry: h.games, moje_wr: `${Math.round((100 * h.win) / h.games)} %`, meta_wr: metaText(id),
      vyhoda_proti_soupericum: v.soucet, detail: v.det,
      skore: Math.round(sk * 10) / 10, znamka: znamkaZeSkore(sk),
    };
  }));
  hodnoceni.sort((a, b) => b.skore - a.skore);
  d.alternativy_z_meho_poolu = hodnoceni.slice(0, 6);
  const lepsi = hodnoceni.filter((x) => x.skore > mojeSkore + 1).length;
  d.poradi_picku_v_poolu = hodnoceni.length
    ? (lepsi ? `${lepsi} z ${hodnoceni.length} hrdinů z poolu by podle dat byli lepší volba` : `lepší volbu z poolu data nenabízí (porovnáno ${hodnoceni.length} hrdinů)`)
    : "v poolu nejsou alternativy na porovnání";
  d.vysvetlivky = "výhoda = o kolik procentních bodů má hrdina proti danému soupeři vyšší winrate než je jeho průměr (matchupy ze STRATZ Divine+, když je nastavený STRATZ_TOKEN, jinak z OpenDoty; malé vzorky tlumené); skóre = výhoda proti soupeřům viditelným při picku + (winrate hrdiny v Divine+ − 50) + polovina osobní výhody; pick_znamka_z_dat = skóre převedené na 1–10 (0 b. = 6)";
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
  const smrtiLajna = [];
  for (const p of zapas.players)
    for (const k of p.kills_log || []) if (k.key === mujNpc && k.time <= 600) smrtiLajna.push([k.time, jm(p)]);
  const smrti = smrtiLajna.sort((a, b) => a[0] - b[0]).map(([t, kdo]) => `${cas(t)} (zabil ${kdo})`);
  const zabil = (ja.kills_log || []).filter((k) => k.time <= 600).map((k) => cas(k.time));
  const konec = minuty[minuty.length - 1];
  return {
    souperi_na_lajne: soup.map(jm), spoluhraci_na_lajne: spol.map(jm),
    po_minutach: minuty,
    vysledek_lajny_10min: konec?.rozdil_zlata_vs_souper == null ? "nelze určit"
      : konec.rozdil_zlata_vs_souper > 400 ? "vyhraná" : konec.rozdil_zlata_vs_souper < -400 ? "prohraná" : "vyrovnaná",
    nejvetsi_zvrat: zvrat ? `${zvrat.min}. minuta: rozdíl zlata se změnil o ${zvrat.zmena > 0 ? "+" : ""}${zvrat.zmena}` : null,
    smrti_do_10min: smrti, killy_do_10min: zabil,
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

// ------------------------------------------------------------ STRATZ (Divine+ statistiky)

async function stratz(query, variables) {
  if (!process.env.STRATZ_TOKEN) throw new Error("chybí STRATZ_TOKEN");
  const r = await fetch("https://api.stratz.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.STRATZ_TOKEN, "User-Agent": "STRATZ_API" },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error("STRATZ vrátil " + r.status);
  const j = await r.json();
  if (j.errors) throw new Error("STRATZ: " + (j.errors[0]?.message || "chyba dotazu"));
  return j.data;
}

// core/support podle pořadí net worthu v týmu
function jeSupportV(zapas, ja) {
  const tym = zapas.players.filter((p) => jeRadiant(p) === jeRadiant(ja)).sort((a, b) => (b.net_worth || 0) - (a.net_worth || 0));
  return { support: tym.indexOf(ja) >= 3, poradi: tym.indexOf(ja) };
}
// pozice 1–5 (odhad z lajny a net worthu)
function pozice(zapas, ja) {
  const { support, poradi } = jeSupportV(zapas, ja);
  if (!support) return [1, 2, 3].includes(ja.lane_role) ? ja.lane_role : Math.min(3, poradi + 1);
  if (ja.lane_role === 1) return 5;
  if (ja.lane_role === 3) return 4;
  return poradi === 3 ? 4 : 5;
}

// průměr Divine+ hráčů na stejném hrdinovi a pozici: LH, zlato, XP po minutách + časy nákupů itemů
async function srovnaniDivine(zapas, ja, k) {
  if (!process.env.STRATZ_TOKEN || !Array.isArray(ja.lh_t)) return null;
  const pos = pozice(zapas, ja);
  const hero = ja.hero_id;
  const d = await cached(`cache:divine:${hero}:${pos}`, 86400, () => stratz(`query D($h: Short!, $hs: [Short]) { heroStats {
      stats(heroIds: $hs, bracketBasicIds: [DIVINE_IMMORTAL], positionIds: [POSITION_${pos}], groupByTime: true, maxTime: 20) { time matchCount cs dn networth xp level deaths }
      itemFullPurchase(heroId: $h, bracketBasicIds: [DIVINE_IMMORTAL], positionIds: [POSITION_${pos}]) { itemId time matchCount instance }
    } }`, { h: hero, hs: [hero] }));
  const stats = d?.heroStats?.stats || [];
  if (!stats.length) return null;
  const vMinute = (m) => stats.find((x) => x.time === m);
  const mujNpc = k.heroes[hero]?.name;
  const casySmrti = [];
  for (const p of zapas.players) for (const kl of p.kills_log || []) if (kl.key === mujNpc) casySmrti.push(kl.time);
  const smrtiDo = (m) => (zapas.version != null ? casySmrti.filter((t) => t <= m * 60).length : null);
  const minuty = [];
  for (const m of [5, 10, 15, 20]) {
    const s = vMinute(m);
    if (!s || vMin(ja.lh_t, m) == null) continue;
    minuty.push({
      min: m,
      LH: { ja: vMin(ja.lh_t, m), divine: Math.round(s.cs) },
      zlato: { ja: vMin(ja.gold_t, m), divine: Math.round(s.networth) },
      XP: { ja: vMin(ja.xp_t, m), divine: Math.round(s.xp) },
      smrti: { ja: smrtiDo(m), divine: Math.round(s.deaths * 10) / 10 },
    });
  }
  // medián času nákupu (první kus) každého itemu
  const podleItemu = {};
  for (const x of d.heroStats.itemFullPurchase || []) {
    if (x.instance && x.instance > 1) continue;
    (podleItemu[x.itemId] = podleItemu[x.itemId] || []).push(x);
  }
  const median = (rows) => {
    const sum = rows.reduce((a, r) => a + r.matchCount, 0);
    let acc = 0;
    for (const r of rows.slice().sort((a, b) => a.time - b.time)) { acc += r.matchCount; if (acc >= sum / 2) return { min: r.time, n: sum }; }
    return null;
  };
  const videno = new Set(), itemy = [];
  for (const n of ja.purchase_log || []) {
    const it = k.items[n.key];
    if (!it || n.key.startsWith("recipe_") || (it.cost || 0) < 1500 || videno.has(n.key)) continue;
    videno.add(n.key);
    const md = podleItemu[it.id] ? median(podleItemu[it.id]) : null;
    if (!md || md.n < 100) continue;
    const rozdil = Math.round(n.time / 60 - md.min);
    itemy.push({ item: it.dname || n.key, ja: cas(n.time), divine_median: `${md.min}:00`, rozdil_min: rozdil });
    if (itemy.length >= 6) break;
  }
  return { pozice: `pos ${pos}`, vzorek_zapasu: stats[0].matchCount, minuty, itemy,
    poznamka: "průměr Divine+ hráčů na stejném hrdinovi a pozici (STRATZ); zlato = OpenDota zlato vs STRATZ net worth, orientačně" };
}

// ------------------------------------------------------------ smrti: co stály, a o kolik později byly itemy

const XP_LEVEL = [0, 240, 640, 1160, 1760, 2440, 3200, 4000, 4900, 5900, 7000, 8200, 9500, 10900, 12400, 14000, 15700,
  17500, 19400, 21400, 23600, 26000, 28600, 31400, 34400, 37400, 40400, 43400, 46400, 49400];
const RESPAWN = [6, 8, 10, 14, 16, 26, 28, 30, 32, 34, 36, 44, 46, 48, 50, 52, 54, 65, 70, 75, 80, 85, 90, 95, 100, 100, 100, 100, 100, 100];
const levelZXp = (xp) => { let l = 1; while (l < XP_LEVEL.length && xp >= XP_LEVEL[l]) l++; return l; };
const zaMinutu = (rada, m) => {
  if (!Array.isArray(rada) || rada.length < 2) return 0;
  const a = Math.max(0, m - 2), b = Math.min(rada.length - 1, m + 2);
  return b > a ? (rada[b] - rada[a]) / (b - a) : 0;
};

function smrtiCena(zapas, ja, k) {
  if (!Array.isArray(ja.gold_t) || !Array.isArray(ja.xp_t)) return null;
  const mujNpc = k.heroes[ja.hero_id]?.name;
  const jm = (p) => k.heroes[p.hero_id]?.localized_name || "?";
  const radiant = jeRadiant(ja), nasStr = radiant ? "goodguys" : "badguys", mujTymId = radiant ? 2 : 3;
  const fighty = zapas.teamfights || [];
  const smrti = [];
  for (const p of zapas.players) for (const kl of p.kills_log || []) if (kl.key === mujNpc) smrti.push({ t: kl.time, kdo: jm(p) });
  smrti.sort((a, b) => a.t - b.t);
  const out = smrti.map(({ t, kdo }) => {
    const m = Math.max(0, Math.floor(t / 60));
    const xp = vMin(ja.xp_t, m) ?? ja.xp_t[ja.xp_t.length - 1];
    const lvl = levelZXp(xp);
    const respawn = RESPAWN[lvl - 1] || 100;
    const gpm = zaMinutu(ja.gold_t, m), xpm = zaMinutu(ja.xp_t, m);
    const nw = vMin(ja.gold_t, m) ?? 0;
    const ztraceno = Math.round(50 + nw / 40);
    const nevyfarmeno = Math.round((respawn * gpm) / 60);
    const vTf = fighty.some((f) => f.start - 5 <= t && t <= f.end + 5);
    const ztraty = (zapas.objectives || []).filter((o) => o.time > t && o.time <= t + 90).map((o) => {
      if (o.type === "building_kill" && (o.key || "").includes(nasStr)) return `naše ${(o.key || "").replace(/npc_dota_(goodguys|badguys)_/, "")}`;
      if (o.type === "CHAT_MESSAGE_ROSHAN_KILL" && o.team && o.team !== mujTymId) return "Roshan pro soupeře";
      return null;
    }).filter(Boolean);
    return { t, cas: cas(t), zabil: kdo, typ: vTf ? "teamfight" : "pick-off", level: lvl, respawn_s: respawn,
      ztracene_zlato: ztraceno, nevyfarmene_zlato: nevyfarmeno, ztracene_XP: Math.round((respawn * xpm) / 60),
      celkem_zlata: ztraceno + nevyfarmeno, tym_ztratil_do_90s: ztraty };
  });
  // o kolik dřív by byly klíčové itemy bez smrtí (cena smrtí před nákupem / průměrné GPM do té doby)
  const itemy = [], videno = new Set();
  for (const n of ja.purchase_log || []) {
    const it = k.items[n.key];
    if (!it || n.key.startsWith("recipe_") || (it.cost || 0) < 2000 || videno.has(n.key) || n.time <= 0) continue;
    videno.add(n.key);
    const pred = out.filter((s) => s.t < n.time);
    if (!pred.length) continue;
    const cena = pred.reduce((a, s) => a + s.celkem_zlata, 0);
    const gps = (vMin(ja.gold_t, Math.floor(n.time / 60)) || 0) / Math.max(60, n.time);
    if (gps <= 0) continue;
    const posun = Math.min(n.time - 60, Math.round(cena / gps));
    itemy.push({ item: it.dname || n.key, koupeno: cas(n.time), bez_smrti_cca: cas(n.time - posun), driv_o: cas(posun), smrti_pred_nakupem: pred.length });
    if (itemy.length >= 5) break;
  }
  const celkem = out.reduce((a, s) => a + s.celkem_zlata, 0);
  return {
    smrti: out.map(({ t, ...x }) => x),
    souhrn: out.length ? `${out.length} smrtí, celkem cca ${celkem} zlata a ${Math.round(out.reduce((a, s) => a + s.respawn_s, 0) / 60 * 10) / 10} min mrtvý` : "bez smrtí od hrdinů",
    itemy_bez_smrti: itemy,
    poznamka: "odhad: ztracené zlato = 50 + zlato/40; nevyfarmené = respawn × GPM v té minutě; respawn podle levelu (přibližná tabulka)",
  };
}

// ------------------------------------------------------------ draft obou týmů a spoluhráči

const ATRIBUT = { str: "síla", agi: "obratnost", int: "inteligence", all: "univerzální" };
function draftTymu(zapas, ja, k) {
  const radiant = jeRadiant(ja);
  const popis = (p) => {
    const h = k.heroes[p.hero_id] || {};
    return { hrdina: h.localized_name || "?", pozice: `pos ${pozice(zapas, p)}`, role: (h.roles || []).join("/"),
      utok: h.attack_type === "Melee" ? "melee" : h.attack_type ? "ranged" : "?", atribut: ATRIBUT[h.primary_attr] || h.primary_attr || "?" };
  };
  const soucty = (tym) => {
    const c = {};
    for (const p of tym) for (const r of k.heroes[p.hero_id]?.roles || []) c[r] = (c[r] || 0) + 1;
    return c;
  };
  const muj = zapas.players.filter((p) => jeRadiant(p) === radiant), soup = zapas.players.filter((p) => jeRadiant(p) !== radiant);
  return {
    muj_tym: muj.map(popis), souperi: soup.map(popis),
    role_v_tymu: { muj: soucty(muj), souperi: soucty(soup) },
    vysvetlivky: "role = role hrdinů z OpenDoty (Carry, Support, Nuker, Disabler, Initiator, Durable, Escape, Pusher); pozice odhadnuta z lajny a net worthu",
  };
}

function spoluhraci(zapas, ja, k) {
  const radiant = jeRadiant(ja);
  const pct = (p, key) => (p.benchmarks && p.benchmarks[key] && p.benchmarks[key].pct != null ? Math.round(p.benchmarks[key].pct * 100) : null);
  const radek = (p) => ({
    hrdina: k.heroes[p.hero_id]?.localized_name || "?", pozice: `pos ${pozice(zapas, p)}`, ja: p === ja,
    KDA: `${p.kills}/${p.deaths}/${p.assists}`, GPM: p.gold_per_min, net_worth: p.net_worth,
    GPM_percentil: pct(p, "gold_per_min"), hero_damage: p.hero_damage,
    ucast_tf_pct: p.teamfight_participation != null ? Math.round(p.teamfight_participation * 100) : null,
  });
  const tym = zapas.players.filter((p) => jeRadiant(p) === radiant).map(radek);
  const ost = tym.filter((x) => !x.ja && x.GPM_percentil != null);
  const muj = tym.find((x) => x.ja);
  return {
    muj_tym: tym,
    prumerny_GPM_percentil_spoluhracu: ost.length ? Math.round(ost.reduce((a, x) => a + x.GPM_percentil, 0) / ost.length) : null,
    muj_GPM_percentil: muj?.GPM_percentil ?? null,
    smrti_tymu_celkem: zapas.players.filter((p) => jeRadiant(p) === radiant).reduce((a, p) => a + (p.deaths || 0), 0),
    vysvetlivky: "GPM percentil = proti hráčům na stejném hrdinovi (OpenDota benchmarky)",
  };
}

// měřitelné metriky zápasu (pro tréninkový plán a statistiky)
function metriky(zapas, ja, k, data) {
  const mujNpc = k.heroes[ja.hero_id]?.name;
  let smrti10 = 0;
  for (const p of zapas.players) for (const kl of p.kills_log || []) if (kl.key === mujNpc && kl.time <= 600) smrti10++;
  const parsed = zapas.version != null;
  return {
    smrti: ja.deaths ?? null,
    smrti_do_10: parsed ? smrti10 : null,
    LH_10: vMin(ja.lh_t, 10),
    pickoffy: parsed && Array.isArray(data.smrti) ? data.smrti.filter((t) => t.includes("MIMO teamfight")).length : null,
    ucast_tf: ja.teamfight_participation != null ? Math.round(ja.teamfight_participation * 100) : null,
    GPM: ja.gold_per_min ?? null,
    obs: ja.obs_placed ?? null,
    delka_s: zapas.duration,
    vyhra: (ja.player_slot < 128) === zapas.radiant_win,
  };
}

// ------------------------------------------------------------ známky z dat (objektivní kotva pro AI)

const prumerZ = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function znamkyZDat(zapas, ja, data) {
  const z = {}, proc = {};
  const radiant = jeRadiant(ja);
  const minut = Math.max(10, zapas.duration / 60);
  const tym = zapas.players.filter((p) => jeRadiant(p) === radiant).sort((a, b) => (b.net_worth || 0) - (a.net_worth || 0));
  const support = tym.indexOf(ja) >= 3;
  const bm = ja.benchmarks || {};
  const pct = (key) => (bm[key] && bm[key].pct != null ? bm[key].pct : null);
  const zPct = (p) => omez(Math.round(1 + 9 * p), 1, 10);

  // farma: percentil proti hráčům na stejném hrdinovi (support se měří víc přes XP)
  const fk = support ? ["xp_per_min", "gold_per_min"] : ["gold_per_min", "last_hits_per_min"];
  const fp = fk.map(pct).filter((x) => x != null);
  if (fp.length) {
    z.farma = zPct(prumerZ(fp));
    proc.farma = `${fk.map((key) => `${key.replace(/_/g, " ")} ${pct(key) != null ? Math.round(pct(key) * 100) + ". percentil" : "–"}`).join(", ")} proti stejnému hrdinovi`;
  }

  // lajna: rozdíl zlata v 10. minutě proti soupeři na lajně (core proti nejbohatšímu, support proti nejchudšímu)
  const proti = { 1: 3, 3: 1, 2: 2 }[ja.lane_role];
  const soup = zapas.players.filter((p) => jeRadiant(p) !== radiant && p.lane_role === proti);
  const g10 = vMin(ja.gold_t, 10);
  const sg = soup.map((p) => vMin(p.gold_t, 10)).filter((x) => x != null);
  if (proti && g10 != null && sg.length) {
    const diff = g10 - (support ? Math.min(...sg) : Math.max(...sg));
    z.lajna = omez(Math.round(6 + diff / 350), 1, 10);
    proc.lajna = `zlato v 10. min ${diff >= 0 ? "+" : ""}${diff} proti ${support ? "nejchudšímu" : "nejbohatšímu"} soupeři na lajně`;
  }

  // teamfighty: účast (30 % → 1, 80 % → 10)
  if (ja.teamfight_participation != null && (zapas.teamfights || []).length >= 2) {
    const tp = ja.teamfight_participation;
    z.teamfighty = omez(Math.round(1 + (9 * (tp - 0.3)) / 0.5), 1, 10);
    proc.teamfighty = `účast v teamfightech ${Math.round(tp * 100)} %`;
  }

  // pozicování: smrti mimo teamfight (pick-offy) přepočtené na 30 minut
  if (zapas.version != null && Array.isArray(data.smrti)) {
    const pickoffy = data.smrti.filter((t) => t.includes("MIMO teamfight")).length;
    const na30 = (pickoffy * 30) / minut;
    z.pozicovani = omez(Math.round(9.5 - 1.6 * na30), 1, 10);
    proc.pozicovani = `${pickoffy}× smrt mimo teamfight za ${Math.round(minut)} min`;
  }

  // pick: skóre z draftu (matchupy proti viditelným soupeřům, meta v ranku, osobní komfort)
  if (data.draft && data.draft.pick_znamka_z_dat) {
    z.pick = data.draft.pick_znamka_z_dat;
    proc.pick = `skóre picku ${data.draft.skore_meho_picku} b.`;
  }

  const ost = ["farma", "lajna", "teamfighty", "pozicovani"].map((key) => z[key]).filter(Boolean);
  if (ost.length >= 2) z.celkem = omez(Math.round(prumerZ(ost)), 1, 10);
  return Object.keys(z).length ? { ...z, jak_spocitano: proc, role_podle_net_worthu: support ? "support" : "core" } : null;
}

// AI známky drž u dat: max. ±2 (pick ±1), chybějící doplň z dat
function zkombinujHodnoceni(h, zd, draftData) {
  if (!zd) return h;
  const out = h ? { ...h } : null;
  if (!out) {
    const ost = KATEGORIE.filter((key) => zd[key]);
    if (!zd.celkem || ost.length < 3) return null;
    const vysl = { stitky_chyb: [], silne_stranky: [], cil_na_dalsi_hru: null };
    for (const key of ost) vysl[key] = zd[key];
    return zkombinujHodnoceni(vysl, zd, draftData);
  }
  for (const key of KATEGORIE) {
    if (!zd[key]) continue;
    const tol = key === "pick" ? 1 : 2;
    out[key] = out[key] ? omez(out[key], zd[key] - tol, zd[key] + tol) : zd[key];
  }
  out.z_dat = Object.fromEntries(KATEGORIE.filter((key) => zd[key]).map((key) => [key, zd[key]]));
  out.z_dat_jak = zd.jak_spocitano || {};
  if (draftData && draftData.pick_znamka_z_dat) {
    out.pick_detail = {
      znamka: draftData.pick_znamka_z_dat, skore: draftData.skore_meho_picku,
      rozpad: draftData.pick_rozpad || null, poradi: draftData.poradi_picku_v_poolu || null,
      counterpick: draftData.counterpick_po_mne || null,
      alternativy: (Array.isArray(draftData.alternativy_z_meho_poolu) ? draftData.alternativy_z_meho_poolu : [])
        .slice(0, 3).map((a) => ({ hrdina: a.hrdina, znamka: a.znamka, moje_wr: a.moje_wr, moje_hry: a.moje_hry, meta_wr: a.meta_wr })),
      role: draftData.moje_role_v_zapase || null,
      pool_poznamka: draftData.poznamka_k_poolu || null,
      k_nauceni: (Array.isArray(draftData.k_nauceni_pro_tuhle_roli) ? draftData.k_nauceni_pro_tuhle_roli : [])
        .slice(0, 4).map((a) => ({ hrdina: a.hrdina, znamka: a.znamka, meta_wr: a.meta_wr })),
    };
  }
  return out;
}

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
  data.znamky_z_dat = znamkyZDat(zapas, ja, data);
  try { data.smrti_a_co_staly = smrtiCena(zapas, ja, k); } catch { /* bez rozparsovaného replaye */ }
  try { data.draft_obou_tymu = draftTymu(zapas, ja, k); } catch {}
  // pozice všech hrdinů v zápase (AI je píše do závorky: „Rubick (4)“)
  try { data.pozice_hrdinu = Object.fromEntries(zapas.players.map((p) => [k.heroes[p.hero_id]?.localized_name || "?", pozice(zapas, p)])); } catch {}
  try { data.spoluhraci = spoluhraci(zapas, ja, k); } catch {}
  data.srovnani_s_divine_plus = await srovnaniDivine(zapas, ja, k).catch((e) => ({ chyba: e.message }));
  if (!data.srovnani_s_divine_plus) delete data.srovnani_s_divine_plus;
  // metriky nejdou do AI, jen do uloženého záznamu
  Object.defineProperty(data, "_metriky", { value: metriky(zapas, ja, k, data), enumerable: false });
  return data;
}

// ------------------------------------------------------------ Claude

const MODEL = () => process.env.TRENER_MODEL || "claude-opus-5-5";
const MODEL_LEVNY = () => process.env.TRENER_MODEL_KONTROLA || "claude-sonnet-5-5";
const webTool = (n) => (process.env.TRENER_WEB === "0" ? {} : { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: n }] });

const SYSTEM = `Jsi špičkový trenér Doty 2 (úroveň profesionálního analytika a coache).
Dostaneš data z jednoho zápasu hráče. Napiš česky konkrétní a upřímný rozbor v Markdownu.

KALIBRACE: Úroveň hráče je v "hrac_uroven" (rank). Rady přizpůsob jí – u Divine/Immortal
vynech základy (kupuj wardy, last hituj, sleduj minimapu), jdi do detailů: timingy, rozhodování,
pozicování, čtení mapy, power spiky, tempo. U nižších ranků můžeš být základnější.

PODKLADY: Než začneš psát, můžeš použít webové vyhledávání (max. 3 hledání) k ověření
aktuálního patche, buildů a rad pro hrdinu. Pokud je v datech "znalosti_o_hrdinovi", ber
hráčovy poznámky a uložený guide jako důležitý kontext (guide může být starší než patch).
Postup hledání nevypisuj.

Struktura (drž se jí, nadpisy přesně takhle):
## Shrnutí
Přesně 4 odrážky: **Známka X/10** a jednou větou proč (kotvou jsou "znamky_z_dat"; když se od nich
výrazně odchýlíš, řekni proč) · **Co rozhodlo zápas** (konkrétní moment nebo fáze s časem) ·
**Já, nebo tým?** (z "spoluhraci": byl hráč nad/pod průměrem svého týmu – GPM percentil, KDA, účast
ve fightech, smrti týmu; férově, bez shazování spoluhráčů) · **Hlavní věc na zlepšení** (jedna, nejdražší chyba).
## Pick
Vyjdi ze známky picku z dat ("draft.pick_znamka_z_dat", "pick_rozpad": matchupy proti soupeřům
viditelným při picku, winrate hrdiny v Divine+, hráčovy výsledky na hrdinovi); odchyl se nejvýš o 1
a jen s jasným důvodem (synergie s týmem, patch). Za counterpick, který přišel až po hráči, nemůže
("counterpick_po_mne"). Alternativy POUZE z "alternativy_z_meho_poolu" (jsou už vybrané pro hráčovu
roli "moje_role_v_zapase", mají vlastní známku) – 2–3, každá jednou větou proč. Pokud je v datech
"poznamka_k_poolu" a "k_nauceni_pro_tuhle_roli", řekni na rovinu, že pro tuhle roli nemá pool, a
doporuč 2 hrdiny k naučení z "k_nauceni_pro_tuhle_roli". Nikdy nedoporučuj hrdinu z jiné role.
## Draft obou týmů
3–4 odrážky z "draft_obou_tymu": silné a slabé stránky obou sestav (iniciace, disable, push, late game,
melee/ranged, magický vs. fyzický damage), co měl hráčův tým v plánu (kdy je silný, o co hrát) a jak
měl hrát proti soupeřově sestavě.
## Lajna (0–10 min)
Z "lajna_detail": kdo lajnu vyhrál a kdy se zlomila (nejvetsi_zvrat). Krátká tabulka jen klíčových
minut (3–5 řádků: minuta, tvoje LH, LH soupeře, rozdíl zlata). Pokud je v datech
"srovnani_s_divine_plus", srovnej LH v 5. a 10. minutě s průměrem Divine+ hráčů na stejném hrdinovi
a pozici (to je hlavní měřítko; zlato a XP jen orientačně). Jinak srovnej s profíkem
("srovnani_s_profikem": LH_10min, zlato_10min – jeden konkrétní zápas, ne pravidlo).
Pak 1–2 konkrétní věci, co měl hráč na lajně udělat jinak (co, kdy, proč).
## Největší chyby
3–4 chyby seřazené podle dopadu (nejdražší první). Každá přesně v tomhle tvaru:
**MM:SS – krátký název** · *Dopad:* co to stálo podle dat (u smrtí čísla ze "smrti_a_co_staly":
zlato, XP, doba mrtvý, co tým ztratil do 90 s; jinak věž, Roshan, prohraný fight) · *Tvoje chyba?*
ano / spíš ano / nevyhnutelné (pick-off na farmě bez vize = chyba; smrt při obraně high ground nebo
výměna za objektiv = často v pořádku) · *Co se stalo:* 1–2 věty · *Co udělat místo toho:* konkrétní
alternativní akce v té situaci (kam jít, co koupit, kdy se stáhnout), ne obecná rada.
## Co šlo dobře
2–4 odrážky s čísly a časy. Přidej srovnání s hráčovými minulými hrami ("srovnani_s_mym_prumerem",
např. „3. nejlepší GPM z posledních 20“) a z "pamet_trenera", jestli splnil cíl z minulé hry
("cil_z_minule_hry") a jestli se opakují stejné chyby.
## Build a timingy
Byl build rozumný vůči soupeřům a patchi? Malá tabulka timingů klíčových itemů: tvůj čas, medián
Divine+ ("srovnani_s_divine_plus.itemy", jinak profík) a „bez smrtí cca“ ("smrti_a_co_staly.itemy_bez_smrti"
– o kolik dřív by item byl bez smrtí). Zmiň i zbytečné nebo pozdní nákupy, pokud jsou z dat vidět.
## Momenty k shlédnutí v replayi
4–6 časových úseků seřazených podle času: - **MM:SS–MM:SS** – na co se dívat (minimapa, pozice, vize,
co měl soupeř). Okno začínej cca 20–30 s před událostí.
## Cíl na další hru
Jeden měřitelný cíl (např. „do 10. min max. 1 smrt a 55+ LH“).

Pravidla: Čísla, časy a jména ber jen z dat, nevymýšlej si situace, které z nich nevyplývají.
U KAŽDÉ zmínky hrdiny (tvůj tým i soupeř) napiš do závorky jeho pozici z "pozice_hrdinu", např. „Rubick (4)“,
„Ogre Magi (5)“ – při první zmínce v každé sekci vždy, dál podle potřeby; u hrdinů z alternativ picku ne.
Délku zápasu ber výhradně z "zapas.delka". V textu nikdy nezmiňuj technické názvy polí z dat
(např. alternativy_z_meho_poolu) – piš normální češtinou („z tvého hero poolu“).
Nemáš pozice na mapě, takže u smrtí mluv o pravděpodobných příčinách. Pokud replay není
rozparsovaný nebo nějaká data chybí, řekni to a hodnoť jen to, co máš.
Žádné obecné fráze typu „hraj opatrněji“ nebo „sleduj minimapu“ bez konkrétní situace a času.
Buď přímý jako dobrý trenér, ne zbytečně pochvalný, ale ani zlý. Max. ~1100 slov, krátké odstavce.`;

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

// Při webovém vyhledávání může API odpověď přerušit (stop_reason "pause_turn") –
// pak se pošle znovu i s tím, co už model napsal, a on pokračuje. Max. pár kol.
const MAX_POKRACOVANI = 4;

// jeden streamovaný požadavek: píše text do res a skládá obsahové bloky (kvůli pokračování)
async function streamJednou(body, res, pis) {
  const r = await claudeFetch({ ...body, stream: true });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", stop = null;
  const bloky = [], jsonVstup = {};
  const zpracuj = (line) => {
    line = line.trim();
    if (!line.startsWith("data:")) return;
    let ev;
    try { ev = JSON.parse(line.slice(5)); } catch { return; }
    if (ev.type === "content_block_start") {
      const b = { ...ev.content_block };
      bloky[ev.index] = b;
      if (b.type === "text") { b.text = b.text || ""; pis("\n\n", true); }
    } else if (ev.type === "content_block_delta") {
      const b = bloky[ev.index], d = ev.delta || {};
      if (!b) return;
      if (d.type === "text_delta") { b.text += d.text; pis(d.text); }
      else if (d.type === "input_json_delta") jsonVstup[ev.index] = (jsonVstup[ev.index] || "") + (d.partial_json || "");
      else if (d.type === "thinking_delta") b.thinking = (b.thinking || "") + d.thinking;
      else if (d.type === "signature_delta") b.signature = (b.signature || "") + d.signature;
      else if (d.type === "citations_delta") (b.citations = b.citations || []).push(d.citation);
    } else if (ev.type === "content_block_stop") {
      const b = bloky[ev.index];
      if (b && jsonVstup[ev.index] != null) { try { b.input = JSON.parse(jsonVstup[ev.index] || "{}"); } catch { b.input = {}; } }
    } else if (ev.type === "message_delta" && ev.delta?.stop_reason) stop = ev.delta.stop_reason;
    else if (ev.type === "error") throw new Error("Claude API: " + (ev.error?.message || "chyba při generování"));
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { zpracuj(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  buf += dec.decode();
  if (buf) zpracuj(buf);
  return { bloky: bloky.filter(Boolean), stop };
}

// streamuje text do odpovědi a vrací ho celý
async function streamText(body, res) {
  let text = "", stop = null, messages = body.messages;
  const pis = (t, oddelovac) => {
    if (oddelovac) { if (!text) return; }
    res.write(t); text += t;
  };
  for (let kolo = 0; kolo <= MAX_POKRACOVANI; kolo++) {
    const r = await streamJednou({ ...body, messages }, res, pis);
    stop = r.stop;
    if (stop !== "pause_turn") break;
    messages = [...messages, { role: "assistant", content: r.bloky }];
  }
  if (stop === "max_tokens") res.write("\n\n_(Text byl useknutý kvůli limitu délky.)_");
  if (stop === "refusal") res.write("\n\n⚠️ AI odpověď odmítla dokončit.");
  if (!text) res.write(`\n\n⚠️ AI nevrátila žádný text (stop_reason: ${stop}).`);
  return { text, stop };
}

async function textOnce(body) {
  let messages = body.messages, j = null;
  const casti = [];
  for (let kolo = 0; kolo <= MAX_POKRACOVANI; kolo++) {
    const r = await claudeFetch({ ...body, messages, stream: false });
    j = await r.json();
    casti.push(...(j.content || []).filter((b) => b.type === "text").map((b) => b.text));
    if (j.stop_reason !== "pause_turn") break;
    messages = [...messages, { role: "assistant", content: j.content || [] }];
  }
  return { text: casti.join("\n\n").trim(), stop: j?.stop_reason };
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
  model: MODEL(), max_tokens: 16000, ...webTool(5), system: GUIDE_SYSTEM,
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

Úkol 2 – strukturované hodnocení podle rozboru a dat. V DATECH je "znamky_z_dat" – objektivní
známky spočítané z čísel; ber je jako kotvu (odchylka max. 2, u picku max. 1, jen s jasným důvodem
z rozboru). Stupnice: 9–10 výborné na daný rank, 7–8 dobré, 5–6 průměrné, 3–4 slabé, 1–2 velmi špatné.
Známka "celkem" hodnotí výkon v roli, ne výsledek zápasu (prohra s dobrým výkonem může mít 7+).
Známky 1–10 pro kategorie
${KATEGORIE.join(", ")}; štítky chyb POUZE z tohoto seznamu: ${STITKY.join("; ")};
krátké silné stránky; jeden konkrétní měřitelný cíl na další hru.

Vrať POUZE JSON, bez dalšího textu a bez Markdownu:
{"opravy":[{"puvodni":"...","nove":"..."}],
 "hodnoceni":{"celkem":7,"pick":6,"lajna":8,"farma":7,"teamfighty":5,"pozicovani":4,"build":6,
  "stitky_chyb":[{"stitek":"smrt mimo teamfight","cas":"36:48","popis":"krátce"}],
  "silne_stranky":["krátce"],"cil_na_dalsi_hru":"...","cil_z_minule_splnen":true}}
"cil_z_minule_splnen": true/false podle toho, jestli hráč v tomhle zápase splnil "pamet_trenera.cil_z_minule_hry"
(posuď z dat, ne z rozboru); null, když cíl v datech není nebo se z dat nedá posoudit.`;

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
  out.cil_z_minule_splnen = n.cil_z_minule_splnen === true ? true : n.cil_z_minule_splnen === false ? false : null;
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
  hodnoceni = zkombinujHodnoceni(hodnoceni, data.znamky_z_dat, data.draft);
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
  catch (e) { return { text, hodnoceni: zkombinujHodnoceni(null, data.znamky_z_dat, data.draft), opravy: 0, chybaKontroly: e.message }; }
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
  text: vysledek.text, hodnoceni: vysledek.hodnoceni || null,
  detail: detailZaznamu(data), ...extra,
});
// kompaktní data pro karty na stránce (smrti, Divine+, spoluhráči, metriky)
const detailZaznamu = (data) => ({
  metriky: data._metriky || null,
  smrti: data.smrti_a_co_staly || null,
  divine: data.srovnani_s_divine_plus && !data.srovnani_s_divine_plus.chyba ? data.srovnani_s_divine_plus : null,
  spoluhraci: data.spoluhraci ? data.spoluhraci.muj_tym : null,
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

// tělo požadavku – rozbitý JSON nesmí shodit funkci
function teloPozadavku(req) {
  if (typeof req.body !== "string") return req.body || {};
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

const jeChybnyText = (t) => !t || t.trim().length < 300 || /^\s*⚠️/.test(t.trim());

module.exports = {
  OD, ROLE, odGet, nactiKonstanty, heroStats, stratz, pozice, smrtiCena, draftTymu, spoluhraci, metriky, detailZaznamu, srovnaniDivine, znamkyZDat, zkombinujHodnoceni, najdiHrace, shrnuti, pripravData, cas, cached, matchupy, hracInfo, dnes,
  streamText, textOnce, stavRadek, rozebrat, guideBody, MODEL, MODEL_LEVNY, webTool,
  znalosti, ulozZnalosti, nastaveni, ulozNastaveni, guideJeStary, STITKY, KATEGORIE, normalizujHodnoceni,
  maUloziste, redis, klicRozboru, teloPozadavku, ulozRozbor, zaznam, seznamRozboru, smazRozbor, smazane, jeChybnyText,
};
