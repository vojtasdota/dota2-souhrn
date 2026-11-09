// Podklady a zadání pro nástroje AI trenéra: „Jak hrát proti X“, hero pool, dopad patche.

const T = require("./_trener.js");

const pct = (w, g) => (g ? `${Math.round((100 * w) / g)} %` : "–");
const vyhral = (z) => (z.player_slot < 128) === z.radiant_win;

const heroStats = () => T.heroStats();

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
  model: T.MODEL(), max_tokens: 16000, ...T.webTool(4),
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
  model: T.MODEL(), max_tokens: 16000, ...T.webTool(3), system: POOL_SYSTEM,
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
  model: T.MODEL(), max_tokens: 16000, ...T.webTool(5), system: PATCH_SYSTEM,
  messages: [{ role: "user", content: `Dnešní datum: ${T.dnes()}.\nData:\n${JSON.stringify(data, null, 2)}` }],
});


// ------------------------------------------------------------ Rozbor jednoho teamfightu

function fightData(zapas, ja, k, idx) {
  const f = (zapas.teamfights || [])[idx];
  if (!f) { const e = new Error("Teamfight v zápase není."); e.code = 400; throw e; }
  const jm = (id) => k.heroes[id]?.localized_name || "?";
  const podleNpc = {};
  for (const h of Object.values(k.heroes)) podleNpc[h.name] = h.localized_name;
  const radiant = (ja.player_slot < 128);
  const mujTym = (p) => (p.player_slot < 128) === radiant;
  const m = Math.max(0, Math.floor(f.start / 60));
  const soucet = (tym, rada) => tym.reduce((a, p) => a + (Array.isArray(p[rada]) && p[rada].length > m ? p[rada][m] : 0), 0);
  const nas = zapas.players.filter(mujTym), jejich = zapas.players.filter((p) => !mujTym(p));
  const hraci = zapas.players.map((p, i) => {
    const t = (f.players || [])[i] || {};
    return {
      hrdina: jm(p.hero_id), tym: mujTym(p) ? "můj" : "soupeř", ja: p === ja, pozice: `pos ${T.pozice(zapas, p)}`,
      damage: t.damage || 0, healing: t.healing || 0, smrti: t.deaths || 0,
      zabil: Object.entries(t.killed || {}).map(([npc, n]) => `${podleNpc[npc] || npc}${n > 1 ? " ×" + n : ""}`),
      schopnosti: Object.entries(t.ability_uses || {}).map(([a, n]) => `${a} ×${n}`),
      itemy: Object.entries(t.item_uses || {}).map(([it, n]) => `${k.items[it]?.dname || it} ×${n}`),
      zlato: t.gold_delta || 0, xp: t.xp_delta || 0, buyback: t.buybacks || 0,
    };
  });
  const poradiKillu = [];
  for (const p of zapas.players) for (const kl of p.kills_log || [])
    if (kl.time >= f.start - 10 && kl.time <= f.end + 10) poradiKillu.push([kl.time, `${T.cas(kl.time)} ${jm(p.hero_id)}${mujTym(p) ? " (náš)" : ""} zabil ${podleNpc[kl.key] || kl.key}`]);
  poradiKillu.sort((a, b) => a[0] - b[0]);
  const objektivy = (zapas.objectives || []).filter((o) => o.time >= f.start - 30 && o.time <= f.end + 90)
    .map((o) => `${T.cas(o.time)} ${o.type === "building_kill" ? "padla budova " + String(o.key || "").replace(/npc_dota_/, "") : o.type === "CHAT_MESSAGE_ROSHAN_KILL" ? "Roshan" : o.type.replace("CHAT_MESSAGE_", "").toLowerCase()}`);
  return {
    fight: `${T.cas(f.start)}–${T.cas(f.end)}, padlo ${f.deaths} hrdinů`,
    stav_pred_fightem: {
      zlato_nas_tym: soucet(nas, "gold_t"), zlato_souper: soucet(jejich, "gold_t"),
      xp_nas_tym: soucet(nas, "xp_t"), xp_souper: soucet(jejich, "xp_t"),
    },
    poradi_killu: poradiKillu.map((x) => x[1]),
    hraci, objektivy_kolem_fightu: objektivy,
    vysledek_pro_muj_tym: hraci.filter((h) => h.tym === "soupeř").reduce((a, h) => a + h.smrti, 0) - hraci.filter((h) => h.tym === "můj").reduce((a, h) => a + h.smrti, 0),
    vysvetlivky: "vysledek_pro_muj_tym = smrti soupeře − naše smrti; zlato/xp = stav na začátku minuty fightu; schopnosti a itemy = počet použití během fightu",
  };
}

const FIGHT_SYSTEM = `Jsi trenér Doty 2. Rozeber česky v Markdownu JEDEN teamfight podle dat. Hráč je ten s "ja": true.
Struktura:
## Výsledek a výchozí stav (kdo vyhrál, kolik padlo, kdo měl před fightem náskok)
## Jak fight probíhal (kdo začal – odhad z pořadí killů a damage, klíčové schopnosti a itemy obou týmů)
## Co jsi dělal ty (damage, schopnosti, itemy – použil BKB/blink/defenzivní item? umřel jsi a kdy?)
## Proč se vyhrál / prohrál (2–3 hlavní důvody)
## Co příště (2–3 konkrétní věci pro hráče)
Max. ~400 slov. Čísla jen z dat; pozice na mapě nemáš, mluv o pravděpodobných příčinách. Nezmiňuj názvy polí z dat.
U každého hrdiny piš do závorky jeho pozici (číslo 1–5 z "pozice"), např. „Rubick (4)“, „Vengeful Spirit (5)“.`;

const fightBody = (data, rank) => ({
  model: T.MODEL(), max_tokens: 8000, system: FIGHT_SYSTEM,
  messages: [{ role: "user", content: `Rank hráče: ${rank || "neznámý"}.\nData fightu:\n${JSON.stringify(data, null, 2)}` }],
});

// ------------------------------------------------------------ Tréninkový plán

const METRIKY = {
  smrti_do_10: "smrti do 10. minuty",
  LH_10: "last hity v 10. minutě",
  pickoffy: "smrti mimo teamfight",
  smrti: "smrti za zápas",
  ucast_tf: "účast v teamfightech v %",
  GPM: "GPM",
  obs: "položené observer wardy",
};

async function planData(hrac) {
  const rozbory = ((await T.seznamRozboru(60)) || []).filter((r) => String(r.hrac) === String(hrac) && r.hodnoceni);
  const posl = rozbory.slice(0, 20);
  const pocty = {};
  for (const r of posl) for (const st of r.hodnoceni.stitky_chyb || []) pocty[st.stitek] = (pocty[st.stitek] || 0) + 1;
  const prumer = (f) => { const a = posl.map(f).filter((x) => x != null && Number.isFinite(x)); return a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null; };
  const metr = {};
  for (const m of Object.keys(METRIKY)) metr[m] = prumer((r) => r.detail?.metriky?.[m]);
  const zn = {};
  for (const kat of T.KATEGORIE) zn[kat] = prumer((r) => r.hodnoceni[kat]);
  return {
    pocet_rozboru: posl.length,
    nejcastejsi_chyby: Object.entries(pocty).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([st, n]) => `${st} (${n}×)`),
    prumerne_znamky: zn, prumerne_metriky: metr,
    hrdinove: [...new Set(posl.map((r) => r.hrdina))].slice(0, 8),
    posledni_cile: posl.slice(0, 5).map((r) => r.hodnoceni.cil_na_dalsi_hru).filter(Boolean),
  };
}

const PLAN_SYSTEM = `Jsi trenér Doty 2. Z dat hráče (opakované chyby, průměrné známky a metriky z posledních rozborů)
navrhni tréninkový plán na tento týden: 2–3 cvičení zaměřená na nejdražší opakované chyby.
Každé cvičení musí být měřitelné JEDNOU z metrik: ${Object.entries(METRIKY).map(([k, v]) => `${k} (${v})`).join(", ")}.
Cíl nastav realisticky podle hráčova průměru (zlepšení o 15–30 %, ne zázrak).
Vrať POUZE JSON bez dalšího textu:
{"shrnuti":"1–2 věty proč tyhle cviky","cviceni":[{"nazev":"krátce","popis":"co konkrétně dělat ve hře (1–2 věty)","metrika":"smrti_do_10","operator":"<=","cil":1,"her":10}]}
operator je "<=" (méně je lépe) nebo ">=" (víc je lépe); "her" = kolik her má cvičení trvat (5–15).`;

function normalizujPlan(j) {
  const cv = (Array.isArray(j?.cviceni) ? j.cviceni : []).map((c) => ({
    nazev: String(c?.nazev || "").slice(0, 80), popis: String(c?.popis || "").slice(0, 300),
    metrika: METRIKY[c?.metrika] ? c.metrika : null, operator: c?.operator === ">=" ? ">=" : "<=",
    cil: Number(c?.cil), her: Math.min(20, Math.max(3, Math.round(Number(c?.her) || 10))),
  })).filter((c) => c.nazev && c.metrika && Number.isFinite(c.cil)).slice(0, 3);
  return cv.length ? { shrnuti: String(j.shrnuti || "").slice(0, 400), cviceni: cv } : null;
}

const planBody = (data) => ({
  model: T.MODEL(), max_tokens: 6000, system: PLAN_SYSTEM,
  messages: [{ role: "user", content: `Dnešní datum: ${T.dnes()}.\nData:\n${JSON.stringify(data, null, 2)}` }],
});

// ------------------------------------------------------------ Tahák k hrdinovi

const TAHAK_SYSTEM = `Jsi trenér Doty 2. Napiš česky v Markdownu TAHÁK k hrdinovi na jeden pohled před hrou (aktuální patch –
ověř přes webové vyhledávání, max. 3). Žádný úvod, jen tohle, stručně v odrážkách:
## Skill build (pořadí + klíčové talenty)
## Itemy (start → lajna → core → situační s podmínkou KDY)
## Power spiky (level/item → co můžeš dělat)
## Pozor na (3–5 nejhorších soupeřů a proč, jedna věta)
## 3 pravidla (nejdůležitější rady pro tohohle hrdinu)
Max. ~250 slov. Pokud dostaneš hráčovy poznámky nebo uložený guide, zohledni je. Nevypisuj postup hledání.`;

const tahakBody = (hrdina, kontext) => ({
  model: T.MODEL(), max_tokens: 8000, ...T.webTool(3), system: TAHAK_SYSTEM,
  messages: [{ role: "user", content: `Hrdina: ${hrdina}. Dnešní datum: ${T.dnes()}.\nKontext hráče:\n${JSON.stringify(kontext, null, 2)}` }],
});

// ------------------------------------------------------------ Profil hráče

async function profilData(hrac) {
  const rozbory = ((await T.seznamRozboru(200)) || []).filter((r) => String(r.hrac) === String(hrac) && r.hodnoceni);
  const pocty = {}, silne = {};
  for (const r of rozbory) {
    for (const st of r.hodnoceni.stitky_chyb || []) pocty[st.stitek] = (pocty[st.stitek] || 0) + 1;
    for (const x of r.hodnoceni.silne_stranky || []) silne[x] = (silne[x] || 0) + 1;
  }
  const prumer = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
  const zn = {};
  for (const kat of T.KATEGORIE) zn[kat] = prumer(rozbory.map((r) => r.hodnoceni[kat]).filter(Boolean));
  const podleHrdiny = {};
  for (const r of rozbory) (podleHrdiny[r.hrdina] = podleHrdiny[r.hrdina] || []).push(r.hodnoceni.celkem);
  return {
    pocet_rozboru: rozbory.length,
    prumerne_znamky: zn,
    nejcastejsi_chyby: Object.entries(pocty).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([s2, n]) => `${s2} (${n}×)`),
    casto_zminene_silne_stranky: Object.entries(silne).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([s2, n]) => `${s2} (${n}×)`),
    hrdinove: Object.entries(podleHrdiny).sort((a, b) => b[1].length - a[1].length).slice(0, 10).map(([h, a]) => `${h}: ${a.length}×, průměr ${prumer(a)}`),
    posledni_rozbory: rozbory.slice(0, 15).map((r) => ({ hrdina: r.hrdina, vysledek: r.vysledek, znamky: Object.fromEntries(T.KATEGORIE.map((kat) => [kat, r.hodnoceni[kat]])), chyby: (r.hodnoceni.stitky_chyb || []).map((st) => st.stitek), metriky: r.detail?.metriky || null })),
  };
}

const PROFIL_SYSTEM = `Jsi trenér Doty 2. Ze všech rozborů hráče napiš česky v Markdownu jeho HRÁČSKÝ PROFIL:
## Styl hry (2–3 věty: jak hraje, jaké role, agresivní/pasivní, farm/fight)
## Silné stránky (3–4, s čísly z dat)
## Slabiny a typické chyby (3–4, s čísly – kolikrát se opakují)
## Vývoj (zlepšuje se? v čem? podle posledních rozborů vs. celku)
## Na co se teď zaměřit (2–3 priority)
Max. ~450 slov. Čísla jen z dat. Buď upřímný, ne pochvalný.`;

const profilBody = (data) => ({
  model: T.MODEL(), max_tokens: 8000, system: PROFIL_SYSTEM,
  messages: [{ role: "user", content: `Data:\n${JSON.stringify(data, null, 2)}` }],
});

// ------------------------------------------------------------ Otázky k rozboru

const OTAZKA_SYSTEM = `Jsi trenér Doty 2. Hráč se ptá na svůj zápas. Máš DATA zápasu a ROZBOR, který k němu napsal trenér.
Odpovídej česky, stručně (max. ~200 slov, pokud otázka nevyžaduje víc), konkrétně a s čísly a časy z dat.
Když se data k otázce nedají použít, řekni to a odpověz obecně podle znalostí hry (případně ověř přes web).
Nevymýšlej události, které v datech nejsou. Nezmiňuj technické názvy polí z dat.
U hrdinů ze zápasu piš do závorky pozici z "pozice_hrdinu", např. „Tusk (4)“.`;

const otazkaBody = (data, rozbor, historie, otazka) => {
  const messages = [{ role: "user", content: `DATA:\n${JSON.stringify(data)}\n\nROZBOR:\n${String(rozbor || "").slice(0, 20000)}\n\nPotvrď, že máš podklady.` },
    { role: "assistant", content: "Mám data zápasu i rozbor. Ptej se." }];
  for (const h of (Array.isArray(historie) ? historie : []).slice(-6)) {
    if (!h || !h.q || !h.a) continue;
    messages.push({ role: "user", content: String(h.q).slice(0, 1000) }, { role: "assistant", content: String(h.a).slice(0, 4000) });
  }
  messages.push({ role: "user", content: String(otazka).slice(0, 1000) });
  return { model: T.MODEL_LEVNY(), max_tokens: 6000, ...T.webTool(2), system: OTAZKA_SYSTEM, messages };
};

// ------------------------------------------------------------ Kdy hrát a kdy ne

const KDYHRAT_SYSTEM = `Jsi trenér Doty 2 a mentální kouč. Dostaneš statistiky hráče ze všech jeho ranked zápasů (série výher a proher,
pořadí hry v session, hodiny, dny, kombinace den + čas, pauza mezi hrami, aktuální stav). Napiš česky v Markdownu.
Piš hlavně TABULKAMI s čísly, text jen jako krátký závěr pod tabulkou (1–2 věty). Struktura:
## Teď: hrát, nebo pauza?
1–2 věty podle "aktualni_stav" a pravidel níž.
## Dny a časy
Tabulka „Dny“: den | winrate | her | verdikt (✅ hraj / ⚠️ opatrně / ❌ raději ne) – všech 7 dní.
Tabulka „Hodiny“: blok po 2 h | winrate | her | verdikt – jen bloky s her ≥ 10.
Tabulka „Nejlepší a nejhorší kombinace den + čas“: 3 nejlepší a 3 nejhorší z "den_a_cas" s her ≥ 8.
## Série
Tabulka: situace (po 1, 2, 3… výhrách / prohrách v řadě) | winrate další hry | her | verdikt.
Pod ní: po kolika výhrách v řadě nejčastěji prohráváš a po kolika prohrách nejčastěji vyhraješ.
## Session a pauzy
Tabulka: kolikátá hra v kuse | winrate | her | verdikt. Tabulka: pauza před hrou | winrate | her | verdikt.
## Tvoje osobní pravidla
3–5 krátkých číslovaných pravidel (např. „2 prohry v řadě = konec“, „max. 3 hry v kuse“, „ve středu večer nehraj“).
Verdikt: ✅ když winrate ≥ průměr + 4 a her ≥ 15; ❌ když ≤ průměr − 4 a her ≥ 15; jinak ⚠️ nebo „–“ (málo her).
U her < 15 napiš „málo dat“. Neber náhodný šum jako pravidlo. Max. ~500 slov mimo tabulky.`;

const kdyhratBody = (stat) => ({
  model: T.MODEL(), max_tokens: 6000, system: KDYHRAT_SYSTEM,
  messages: [{ role: "user", content: `Dnešní datum: ${T.dnes()}.\nStatistiky:\n${JSON.stringify(stat, null, 2).slice(0, 30000)}` }],
});

// ------------------------------------------------------------ Souhrnný rozbor posledních N zápasů

async function souhrnData(hrac, pocet, typ, k) {
  const jm = (id) => k.heroes[id]?.localized_name || "?";
  const pole = ["hero_id", "start_time", "duration", "radiant_win", "player_slot", "kills", "deaths", "assists", "gold_per_min",
    "xp_per_min", "last_hits", "denies", "hero_damage", "tower_damage", "lane_role", "lobby_type", "game_mode", "party_size", "version"];
  const filtr = typ === "ranked" ? "&lobby_type=7" : typ === "unranked" ? "&lobby_type=0" : "";
  const [list, info, rozbory] = await Promise.all([
    T.odGet(`/players/${hrac}/matches?limit=${pocet + 70}&significant=0${filtr}&${pole.map((x) => "project=" + x).join("&")}`),
    T.hracInfo(hrac).catch(() => null),
    T.seznamRozboru(300).catch(() => null),
  ]);
  const hry = (Array.isArray(list) ? list : []).filter((z) => z.duration >= 600 && z.game_mode !== 23);
  const zap = hry.slice(0, pocet), pred = hry.slice(pocet, pocet + 50);
  if (!zap.length) { const e = new Error("Žádné zápasy k rozboru (zkus jiný typ her)."); e.code = 400; throw e; }
  const vyhral = (z) => (z.player_slot < 128) === z.radiant_win;
  const podleZapasu = {};
  for (const r of rozbory || []) if (String(r.hrac) === String(hrac)) podleZapasu[String(r.match)] = r;
  const prumer = (a, f) => { const v = a.map(f).filter((x) => x != null && Number.isFinite(x)); return v.length ? Math.round((v.reduce((x, y) => x + y, 0) / v.length) * 10) / 10 : null; };
  const souhrn = (a) => a.length ? {
    her: a.length, winrate: `${Math.round((100 * a.filter(vyhral).length) / a.length)} %`,
    KDA_pomer: prumer(a, (z) => (z.kills + z.assists) / Math.max(1, z.deaths)), smrti: prumer(a, (z) => z.deaths),
    GPM: prumer(a, (z) => z.gold_per_min), XPM: prumer(a, (z) => z.xp_per_min),
    LH_za_minutu: prumer(a, (z) => z.last_hits / (z.duration / 60)), hero_damage_za_minutu: prumer(a, (z) => z.hero_damage / (z.duration / 60)),
  } : null;
  const hrdinove = {};
  for (const z of zap) { const h = (hrdinove[jm(z.hero_id)] = hrdinove[jm(z.hero_id)] || { her: 0, vyher: 0 }); h.her++; if (vyhral(z)) h.vyher++; }
  let serie = 0; for (const z of zap) { if (vyhral(z) === vyhral(zap[0])) serie++; else break; }
  const stitky = {};
  const zapasy = zap.map((z) => {
    const r = podleZapasu[String(z.match_id)];
    for (const st of r?.hodnoceni?.stitky_chyb || []) stitky[st.stitek] = (stitky[st.stitek] || 0) + 1;
    return {
      datum: new Date(z.start_time * 1000).toISOString().slice(0, 10), match_id: z.match_id, hrdina: jm(z.hero_id),
      vysledek: vyhral(z) ? "V" : "P", delka: T.cas(z.duration), KDA: `${z.kills}/${z.deaths}/${z.assists}`,
      GPM: z.gold_per_min, XPM: z.xp_per_min, LH: z.last_hits, DN: z.denies, hero_damage: z.hero_damage, tower_damage: z.tower_damage,
      lajna: T.ROLE[z.lane_role] || null, party: (z.party_size || 1) > 1 ? z.party_size : null,
      ranked: z.lobby_type === 7,
      rozbor: r?.hodnoceni ? { znamka: r.hodnoceni.celkem, chyby: (r.hodnoceni.stitky_chyb || []).map((st) => st.stitek), cil: r.hodnoceni.cil_na_dalsi_hru || null } : null,
    };
  });
  return {
    hrac_uroven: info?.rank || null,
    obdobi: `${zapasy[zapasy.length - 1].datum} až ${zapasy[0].datum}`, typ_her: typ || "vše (bez Turba)",
    tyto_zapasy: souhrn(zap), predchozich_az_50_her_pro_srovnani: souhrn(pred),
    aktualni_serie: `${serie} ${vyhral(zap[0]) ? (serie === 1 ? "výhra" : serie < 5 ? "výhry" : "výher") : (serie === 1 ? "prohra" : serie < 5 ? "prohry" : "proher")} v řadě`,
    hrdinove: Object.entries(hrdinove).sort((a, b) => b[1].her - a[1].her).map(([h, x]) => `${h}: ${x.her} her, ${x.vyher} výher`),
    rozebrano_zapasu: zapasy.filter((z) => z.rozbor).length,
    opakovane_chyby_z_rozboru: Object.entries(stitky).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([st, n]) => `${st} (${n}×)`),
    zapasy,
  };
}

const SOUHRN_SYSTEM = `Jsi trenér Doty 2. Rozeber česky v Markdownu hráčových posledních N zápasů DOHROMADY – hledej trendy a vzorce,
ne detail každé hry. Rady přizpůsob ranku hráče (u Divine+ žádné základy). Struktura:
## Shrnutí
3 odrážky: výsledky a forma (s čísly), srovnání s jeho předchozími hrami ("predchozich_az_50_her_pro_srovnani"), hlavní problém.
## Zápasy přehledně
Tabulka: datum | hrdina | V/P | KDA | GPM | LH | známka z rozboru (pokud je, jinak –). Všechny zápasy, nejnovější nahoře.
## Co se opakuje
3–5 vzorců z čísel a z rozborů (např. „v prohrách průměrně 9 smrtí vs. 4 ve výhrách“, „GPM na Ursovi pod tvým průměrem“,
opakované štítky chyb). Každý s čísly.
## Hrdinové a picky
Co fungovalo a co ne, koho hrát víc / míň v dalších hrách.
## Trend
Zlepšuješ se, nebo zhoršuješ? Porovnej první a druhou polovinu období a předchozí hry.
## Na co se zaměřit
3 konkrétní body a na konec jeden měřitelný **Cíl na dalších 5 her**.
Čísla jen z dat, nic si nevymýšlej. Nezmiňuj technické názvy polí. Max. ~750 slov mimo tabulku.`;

const souhrnBody = (data) => ({
  model: T.MODEL(), max_tokens: 16000, system: SOUHRN_SYSTEM,
  messages: [{ role: "user", content: `Dnešní datum: ${T.dnes()}.\nData:\n${JSON.stringify(data, null, 2)}` }],
});

module.exports = { souhrnData, souhrnBody, kdyhratBody, protiData, protiBody, poolData, poolBody, patchData, patchBody, posledniPatch,
  fightData, fightBody, METRIKY, planData, planBody, normalizujPlan, tahakBody, profilData, profilBody, otazkaBody };
