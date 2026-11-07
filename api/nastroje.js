// AI trenér – nástroje (POST {akce, heslo, ...}):
//   proti {hero}        – stream: Jak hrát proti hrdinovi X (uloží se)
//   pool                – stream: zhodnocení hero poolu (uloží se)
//   patch {znovu}       – stream: dopad nejnovějšího patche (uloží se; uložený se vrátí bez placení)
//   guide {hero}        – stream: AI najde aktuální guide k hrdinovi a uloží ho do znalostí
//   znalosti {hero}     – JSON: poznámky a guide k hrdinovi
//   znalosti_ulozit {hero, poznamky}
//   nastaveni / nastaveni_ulozit {autoGuide}
//   ulozene             – JSON: uložené výstupy nástrojů (proti, pool, patch, plan, profil)
//   fight {match, idx, znovu} – stream: rozbor jednoho teamfightu (uloží se)
//   plan                – JSON: nový tréninkový plán na týden (uloží se)
//   tahak {hero}        – stream: tahák k hrdinovi (uloží se do znalostí)
//   profil              – stream: hráčský profil ze všech rozborů (uloží se)
//   otazka {match, otazka, rozbor, historie} – stream: odpověď na otázku k rozboru

const T = require("./_trener.js");
const N = require("./_nastroje.js");

function hracZ(body) {
  return process.env.TRENER_HRAC || String(body.hrac || "").replace(/\D/g, "");
}

// streamuje odpověď AI a po dokončení ji uloží
async function streamAUloz(res, body, uloz) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  try {
    const { text } = await T.streamText(body, res);
    if (!T.jeChybnyText(text) && T.maUloziste()) await uloz(text);
  } catch (e) {
    res.write("\n\n⚠️ " + e.message);
  }
  res.end();
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ error: "Použij POST." }); return; }
  const body = T.teloPozadavku(req);
  if (process.env.TRENER_HESLO && body.heslo !== process.env.TRENER_HESLO) {
    res.status(401).json({ error: "Špatné heslo." }); return;
  }
  const akce = body.akce;
  const potrebujeAI = ["proti", "pool", "patch", "guide", "fight", "plan", "tahak", "profil", "otazka", "kdyhrat"].includes(akce);
  if (potrebujeAI && !process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "Chybí ANTHROPIC_API_KEY." }); return; }
  const potrebujeDB = ["znalosti_ulozit", "nastaveni_ulozit"].includes(akce);
  if (potrebujeDB && !T.maUloziste()) { res.status(501).json({ error: "Úložiště není nastavené." }); return; }

  try {
    const k = await T.nactiKonstanty();
    const heroId = Number(body.hero) || null;
    const heroJm = heroId ? k.heroes[heroId]?.localized_name : null;
    if (["proti", "guide", "znalosti", "znalosti_ulozit", "tahak"].includes(akce) && !heroJm) {
      res.status(400).json({ error: "Vyber hrdinu." }); return;
    }
    const hrac = hracZ(body);
    if (["proti", "pool", "patch", "plan", "profil"].includes(akce) && !hrac) { res.status(400).json({ error: "Chybí ID hráče." }); return; }
    if (["plan", "profil"].includes(akce) && !T.maUloziste()) { res.status(501).json({ error: "Úložiště není nastavené – plán i profil se počítají z uložených rozborů." }); return; }

    switch (akce) {
      case "proti": {
        const data = await N.protiData(hrac, heroId, k);
        return streamAUloz(res, N.protiBody(data), async (text) => {
          await T.redis("SET", `proti:${heroId}`, JSON.stringify({ hero: heroId, hrdina: heroJm, datum: new Date().toISOString(), text }));
          await T.redis("SADD", "proti:seznam", String(heroId));
        });
      }
      case "pool": {
        const data = await N.poolData(hrac, k);
        return streamAUloz(res, N.poolBody(data), (text) =>
          T.redis("SET", "pool:posledni", JSON.stringify({ datum: new Date().toISOString(), text })));
      }
      case "patch": {
        const p = await N.posledniPatch();
        if (!body.znovu && T.maUloziste() && p) {
          const ulozeny = await T.redis("GET", `patch:${p.nazev}`);
          if (ulozeny) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(JSON.parse(ulozeny).text);
            return;
          }
        }
        const data = await N.patchData(hrac, k);
        return streamAUloz(res, N.patchBody(data), async (text) => {
          const zaznam = JSON.stringify({ patch: p?.nazev || "?", datum: new Date().toISOString(), text });
          if (p) await T.redis("SET", `patch:${p.nazev}`, zaznam);
          await T.redis("SET", "patch:posledni", zaznam);
        });
      }
      case "guide": {
        return streamAUloz(res, T.guideBody(heroJm), (text) =>
          T.ulozZnalosti(heroId, { guide: text, guide_datum: new Date().toISOString() }));
      }
      case "fight": {
        const matchId = String(body.match || "").replace(/\D/g, "");
        const idx = Number(body.idx);
        if (!matchId || !Number.isInteger(idx) || idx < 0) { res.status(400).json({ error: "Chybí zápas nebo teamfight." }); return; }
        const klic = `fight2:${matchId}:${idx}:${String(body.hrac || body.hrdina || "").replace(/[^\w-]/g, "")}`;
        if (!body.znovu && T.maUloziste()) {
          const ulozeny = await T.redis("GET", klic);
          if (ulozeny) { res.statusCode = 200; res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.end(ulozeny); return; }
        }
        const zapas = await T.odGet(`/matches/${matchId}`);
        if (zapas.version == null) { res.status(400).json({ error: "Rozbor fightu potřebuje rozparsovaný replay." }); return; }
        const ja = T.najdiHrace(zapas, k.heroes, body.hrac, body.hrdina);
        const data = N.fightData(zapas, ja, k, idx);
        const info = ja.account_id ? await T.hracInfo(ja.account_id).catch(() => null) : null;
        return streamAUloz(res, N.fightBody(data, info?.rank), (text) => T.redis("SET", klic, text, "EX", String(90 * 86400)));
      }
      case "plan": {
        const data = await N.planData(hrac);
        if (data.pocet_rozboru < 3) { res.status(400).json({ error: "Na plán potřebuju aspoň 3 rozbory s hodnocením." }); return; }
        const { text } = await T.textOnce(N.planBody(data));
        let j = null;
        try { const a = text.indexOf("{"), b = text.lastIndexOf("}"); j = JSON.parse(text.slice(a, b + 1)); } catch {}
        const plan = N.normalizujPlan(j);
        if (!plan) { res.status(502).json({ error: "AI nevrátila použitelný plán, zkus to znovu." }); return; }
        const zaznam = { ...plan, datum: new Date().toISOString(), od: Math.floor(Date.now() / 1000), hrac };
        await T.redis("SET", "plan:aktualni", JSON.stringify(zaznam));
        res.status(200).json(zaznam);
        return;
      }
      case "tahak": {
        const zn = (await T.znalosti(heroId).catch(() => null)) || {};
        const kontext = { moje_poznamky: zn.poznamky || null, ulozeny_guide: zn.guide ? String(zn.guide).slice(0, 4000) : null };
        return streamAUloz(res, N.tahakBody(heroJm, kontext), (text) => T.ulozZnalosti(heroId, { tahak: text, tahak_datum: new Date().toISOString() }));
      }
      case "profil": {
        const data = await N.profilData(hrac);
        if (data.pocet_rozboru < 3) { res.status(400).json({ error: "Na profil potřebuju aspoň 3 rozbory s hodnocením." }); return; }
        return streamAUloz(res, N.profilBody(data), (text) =>
          T.redis("SET", "profil:posledni", JSON.stringify({ datum: new Date().toISOString(), pocet: data.pocet_rozboru, text })));
      }
      case "otazka": {
        const matchId = String(body.match || "").replace(/\D/g, "");
        const otazka = String(body.otazka || "").trim();
        if (!matchId || !otazka) { res.status(400).json({ error: "Chybí zápas nebo otázka." }); return; }
        const zapas = await T.odGet(`/matches/${matchId}`);
        const ja = T.najdiHrace(zapas, k.heroes, body.hrac, body.hrdina);
        const data = await T.pripravData(zapas, ja, k);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        try { await T.streamText(N.otazkaBody(data, body.rozbor, body.historie, otazka), res); }
        catch (e) { res.write("\n\n⚠️ " + e.message); }
        res.end();
        return;
      }
      case "kdyhrat": {
        const stat = body.statistiky;
        if (!stat || typeof stat !== "object" || !stat.celkem_her) { res.status(400).json({ error: "Chybí statistiky." }); return; }
        return streamAUloz(res, N.kdyhratBody(stat), (text) =>
          T.redis("SET", "kdyhrat:posledni", JSON.stringify({ datum: new Date().toISOString(), text })));
      }
      case "znalosti": {
        res.status(200).json({ hrdina: heroJm, ...((await T.znalosti(heroId).catch(() => null)) || {}) });
        return;
      }
      case "znalosti_ulozit": {
        const n = await T.ulozZnalosti(heroId, { poznamky: String(body.poznamky || "").slice(0, 8000) });
        res.status(200).json({ ok: true, ...n });
        return;
      }
      case "nastaveni": {
        res.status(200).json(await T.nastaveni());
        return;
      }
      case "nastaveni_ulozit": {
        const zmeny = {};
        if (typeof body.autoGuide === "boolean") zmeny.autoGuide = body.autoGuide;
        res.status(200).json(await T.ulozNastaveni(zmeny));
        return;
      }
      case "ulozene": {
        if (!T.maUloziste()) { res.status(200).json({ proti: [], pool: null, patch: null, plan: null, profil: null }); return; }
        const ids = (await T.redis("SMEMBERS", "proti:seznam")) || [];
        const proti = ids.length ? (await T.redis("MGET", ...ids.map((i) => `proti:${i}`))) : [];
        const [pool, patch, plan, profil, kdyhrat] = await Promise.all(["pool:posledni", "patch:posledni", "plan:aktualni", "profil:posledni", "kdyhrat:posledni"].map((x) => T.redis("GET", x)));
        const parse = (v) => { try { return JSON.parse(v); } catch { return null; } };
        res.status(200).json({
          proti: proti.map(parse).filter(Boolean).sort((a, b) => b.datum.localeCompare(a.datum)),
          pool: parse(pool), patch: parse(patch), plan: parse(plan), profil: parse(profil), kdyhrat: parse(kdyhrat),
        });
        return;
      }
      default:
        res.status(400).json({ error: "Neznámá akce." });
    }
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else { res.write("\n\n⚠️ " + e.message); res.end(); }
  }
};
