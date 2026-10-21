// Podklady a zadání pro nástroje AI trenéra: „Jak hrát proti X“, hero pool, dopad patche.

const T = require("./_trener.js");

const pct = (w, g) => (g ? `${Math.round((100 * w) / g)} %` : "–");
const vyhral = (z) => (z.player_slot < 128) === z.radiant_win;

async function heroStats() {
  return T.cached("cache:herostats", 43200, () => T.odGet("/heroStats"));
}

async function mujPool(hrac, dni) {
  return T.cached(`cache:poolall:${hrac}:${dni}`, 21600, () => T.odGet(`/players/${hrac}/heroes?date=${dni}`));
}

// ------------------------------------------------------------ Jak hrát proti X

async function protiData(hrac, heroId, k) {
  const jm = (id) => k.heroes[id]?.localized_name || "?";
  const X = jm(heroId);
  const pole = ["hero_id", "kills", "deaths", "assists", "radiant_win", "player_slot", "duration"];
  const q = pole.map((x) => `project=${x}`).join("&");
  const [hry, pool, mu, info, rozbory] = await Promise.all([
    T.odGet(`/players/${hrac}/matches?against_hero_id=${heroId}&date=365&${q}`).catch(() => []),
    mujPool(hrac, 365).catch(() => []),
    T.matchupy(heroId).catch(() => null),
    T.hracInfo(hrac).catch(() => null),
    T.seznamRozboru(150).catch(() => null),
  ]);

  const list = Array.isArray(hry) ? hry : [];
  const vyhry = list.filter(vyhral).length;
  const podleHrdiny = {};
  for (const z of list) {
    const h = (podleHrdiny[z.hero_id] = podleHrdiny[z.hero_id] || { g: 0, w: 0, d: 0 });
    h.g++; h.w += vyhral(z) ? 1 : 0; h.d += z.deaths || 0;
  }
  const mojeHryProti = Object.entries(podleHrdiny).sort((a, b) => b[1].g - a[1].g).slice(0, 8)
    .map(([id, h]) => `${jm(id)}: ${h.g} her, ${pct(h.w, h.g)} WR, ${(h.d / h.g).toFixed(1)} smrtí/hru`);

  // můj pool proti X (z matchupů X: čím hůř si X vede proti hrdinovi, tím líp pro mě)
  let poolProti = [];
  if (mu) {
    poolProti = (Array.isArray(pool) ? pool : []).filter((h) => h.games >= 8).map((h) => {
      const x = mu.m[h.hero_id];
      if (!x || !x.g) return null;
      const v = (mu.base - x.w / x.g) * 100 * (x.g / (x.g + 30));
      return { hrdina: jm(h.hero_id), vyhoda_proti_X: Math.round(v * 10) / 10, moje_hry: h.games, moje_wr: pct(h.win, h.games) };
    }).filter(Boolean).sort((a, b) => b.vyhoda_proti_X - a.vyhoda_proti_X);
  }

  const zRozboru = (rozbory || []).filter((r) => String(r.hrac) === String(hrac) && (r.souperi || []).includes(X));
  const pocty = {};
  for (const r of zRozboru) for (const s of r.hodnoceni?.stitky_chyb || []) pocty[s.stitek] = (pocty[s.stitek] || 0) + 1;

  return {
    souper: X,
    hrac_uroven: info?.rank || null,
    moje_hry_proti_nemu_posledni_rok: { celkem: list.length, winrate: pct(vyhry, list.length),
      prumer_smrti: list.length ? (list.reduce((a, z) => a + (z.deaths || 0), 0) / list.length).toFixed(1) : null },
    s_kym_jsem_proti_nemu_hral: mojeHryProti,
    muj_pool_proti_nemu_nejlepsi: poolProti.slice(0, 6),
    muj_pool_proti_nemu_nejhorsi: poolProti.slice(-3).reverse(),
    z_mych_rozboru: { pocet: zRozboru.length,
      opakovane_chyby: Object.entries(pocty).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, n]) => `${s} (${n}×)`),
      prumerna_znamka: zRozboru.filter((r) => r.hodnoceni?.celkem).length
        ? (zRozboru.reduce((a, r) => a + (r.hodnoceni?.celkem || 0), 0) / zRozboru.filter((r) => r.hodnoceni?.celkem).length).toFixed(1) : null },
    vysvetlivky: "vyhoda_proti_X = o kolik procentních bodů je X proti danému hrdinovi slabší než obvykle (matchupy OpenDota, orientačně)",
  };
}

const PROTI_SYSTEM = `Jsi trenér Doty 2. Napiš česky v Markdownu osobní návod „Jak hrát proti ${"${X}"}“ pro hráče,
jehož data dostaneš (rank, výsledky proti tomu hrdinovi, jeho hero pool, opakované chyby).
Přes webové vyhledávání (max. 4 hledání) si ověř aktuální patch: schopnosti, power spiky a
counter itemy. Rady přizpůsob ranku hráče (u Divine+ žádné základy).
Struktura:
## Jak se ti proti němu daří (z dat)
## Proč je nebezpečný (schopnosti, power spiky, timingy)
## Lajna proti němu
## Itemy proti němu (konkrétně, s podmínkou kdy)
## Koho z tvého poolu proti němu pickovat (jen z dat)
## Tvoje opakované chyby proti němu (pokud jsou v datech)
## 3 pravidla do příští hry
Max. ~700 slov. Nevypisuj postup hledání. Čísla ber jen z dat.`;

const protiBody = (data) => ({
  model: T.MODEL(), max_tokens: 6000, ...T.webTool(4),
  system: PROTI_SYSTEM.replace("${X}", data.souper),
  messages: [{ role: "user", content: `Dnešní datum: ${T.dnes()}.\nData:\n${JSON.stringify(data, null, 2)}` }],
});

// ------------------------------------------------------------ Hero pool

async function poolData(hrac, k) {
  const jm = (id) => k.heroes[id]?.localized_name || "?";
  const [rok, pulrok, mesic, counts, hs, info] = await Promise.all([
    mujPool(hrac, 365).catch(() => []), mujPool(hrac, 180).catch(() => []), mujPool(hrac, 30).catch(() => []),
    T.cached(`cache:counts:${hrac}`, 21600, () => T.odGet(`/players/${hrac}/counts`)).catch(() => null),
    heroStats().catch(() => []), T.hracInfo(hrac).catch(() => null),
  ]);
  const b = info?.bracket || 7;
  const meta = {};
  for (const h of Array.isArray(hs) ? hs : []) {
    const p = h[`${b}_pick`], w = h[`${b}_win`];
    if (p) meta[h.id] = { wr: w / p, pick: p, roles: h.roles || [] };
  }
  const mapa = (list) => Object.fromEntries((Array.isArray(list) ? list : []).map((h) => [h.hero_id, h]));
  const m30 = mapa(mesic), m180 = mapa(pulrok);
  const muj = (Array.isArray(rok) ? rok : []).filter((h) => h.games >= 5).sort((a, b2) => b2.games - a.games).slice(0, 30)
    .map((h) => ({
      hrdina: jm(h.hero_id), role: (k.heroes[h.hero_id]?.roles || []).slice(0, 3).join("/"),
      rok: `${h.games} her, ${pct(h.win, h.games)}`,
      pul_roku: m180[h.hero_id] ? `${m180[h.hero_id].games} her, ${pct(m180[h.hero_id].win, m180[h.hero_id].games)}` : "0",
      mesic: m30[h.hero_id] ? `${m30[h.hero_id].games} her, ${pct(m30[h.hero_id].win, m30[h.hero_id].games)}` : "0",
      meta_wr_v_mem_ranku: meta[h.hero_id] ? `${(meta[h.hero_id].wr * 100).toFixed(1)} %` : null,
    }));
  const maxPick = Math.max(1, ...Object.values(meta).map((m) => m.pick));
  const metaTop = Object.entries(meta).filter(([, m]) => m.pick > maxPick * 0.15)
    .sort((a, b2) => b2[1].wr - a[1].wr).slice(0, 25)
    .map(([id, m]) => ({ hrdina: jm(id), role: m.roles.slice(0, 3).join("/"), wr: `${(m.wr * 100).toFixed(1)} %` }));
  const lajny = {};
  for (const [lr, v] of Object.entries(counts?.lane_role || {}))
    if (v.games) lajny[{ 1: "safe", 2: "mid", 3: "off", 4: "jungle" }[lr] || lr] = `${v.games} her, ${pct(v.win, v.games)}`;

  return {
    hrac_uroven: info?.rank || null, lajny_kde_hraju: lajny,
    muj_pool: muj, meta_v_mem_ranku_nejlepsi_wr: metaTop,
    vysvetlivky: "meta = winrate veřejných zápasů v hráčově ranku (OpenDota heroStats)",
  };
}

const POOL_SYSTEM = `Jsi trenér Doty 2. Zhodnoť česky v Markdownu hero pool hráče podle dat (jeho výsledky za
rok/půl roku/měsíc, lajny, meta winrate v jeho ranku). Přes webové vyhledávání (max. 3) si
ověř aktuální patch a metu pro jeho role.
Struktura:
## Shrnutí (role, šíře poolu, hlavní problém)
## Ponechat – jádro poolu (proč, s čísly)
## Zvážit vyřazení (slabé výsledky nebo slabá meta – s čísly)
## Hraješ málo, ale jde ti to
## Přidat do poolu (2–4 hrdinové z aktuální mety pro jeho role, ideálně podobní tomu, co mu jde)
## Doporučený pool na příští týdny (6–8 hrdinů podle role)
Max. ~650 slov. Čísla jen z dat. Nevypisuj postup hledání.`;

const poolBody = (data) => ({
  model: T.MODEL(), max_tokens: 6000, ...T.webTool(3), system: POOL_SYSTEM,
  messages: [{ role: "user", content: `Dnešní datum: ${T.dnes()}.\nData:\n${JSON.stringify(data, null, 2)}` }],
});

// ------------------------------------------------------------ Dopad patche

async function posledniPatch() {
  const list = await T.cached("cache:patch", 21600, () => T.odGet("/constants/patch"));
  const p = Array.isArray(list) ? list[list.length - 1] : null;
  return p ? { nazev: p.name, datum: String(p.date || "").slice(0, 10) } : null;
}

async function patchData(hrac, k) {
  const jm = (id) => k.heroes[id]?.localized_name || "?";
  const [patch, pool] = await Promise.all([posledniPatch(), mujPool(hrac, 90).catch(() => [])]);
  return {
    patch_podle_opendoty: patch,
    moji_hrdinove_posledni_3_mesice: (Array.isArray(pool) ? pool : []).filter((h) => h.games >= 3)
      .sort((a, b) => b.games - a.games).slice(0, 12).map((h) => `${jm(h.hero_id)} (${h.games} her)`),
  };
}

const PATCH_SYSTEM = `Jsi analytik Doty 2. Přes webové vyhledávání (max. 5) najdi oficiální patch notes NEJNOVĚJŠÍHO
patche Doty 2 (OpenDota uvádí verzi v datech; pokud existuje novější písmenková verze, použij
ji a napiš to). Shrň česky v Markdownu jen to, co je důležité pro tohoto hráče:
## Patch (verze a datum)
## Tvoji hrdinové (každý zvlášť: buff/nerf/beze změny + co to znamená v praxi)
## Itemy, které na nich typicky stavíš
## Obecné změny, které tě ovlivní (mapa, mechaniky, neutrální itemy…)
## Co to znamená pro tvůj pool (koho hrát víc, koho míň)
## Zdroje
Max. ~700 slov. Nevymýšlej změny – co nenajdeš, to nepiš. Nevypisuj postup hledání.`;

const patchBody = (data) => ({
  model: T.MODEL(), max_tokens: 6000, ...T.webTool(5), system: PATCH_SYSTEM,
  messages: [{ role: "user", content: `Dnešní datum: ${T.dnes()}.\nData:\n${JSON.stringify(data, null, 2)}` }],
});

module.exports = { protiData, protiBody, poolData, poolBody, patchData, patchBody, posledniPatch };
