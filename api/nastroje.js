// AI trenér – nástroje (POST {akce, heslo, ...}):
//   proti {hero}        – stream: Jak hrát proti hrdinovi X (uloží se)
//   pool                – stream: zhodnocení hero poolu (uloží se)
//   patch {znovu}       – stream: dopad nejnovějšího patche (uloží se; uložený se vrátí bez placení)
//   guide {hero}        – stream: AI najde aktuální guide k hrdinovi a uloží ho do znalostí
//   znalosti {hero}     – JSON: poznámky a guide k hrdinovi
//   znalosti_ulozit {hero, poznamky}
//   nastaveni / nastaveni_ulozit {autoGuide}
//   ulozene             – JSON: uložené výstupy nástrojů (proti, pool, patch)

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
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  if (process.env.TRENER_HESLO && body.heslo !== process.env.TRENER_HESLO) {
    res.status(401).json({ error: "Špatné heslo." }); return;
  }
  const akce = body.akce;
  const potrebujeAI = ["proti", "pool", "patch", "guide"].includes(akce);
  if (potrebujeAI && !process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "Chybí ANTHROPIC_API_KEY." }); return; }
  const potrebujeDB = ["znalosti_ulozit", "nastaveni_ulozit"].includes(akce);
  if (potrebujeDB && !T.maUloziste()) { res.status(501).json({ error: "Úložiště není nastavené." }); return; }

  try {
    const k = await T.nactiKonstanty();
    const heroId = Number(body.hero) || null;
    const heroJm = heroId ? k.heroes[heroId]?.localized_name : null;
    if (["proti", "guide", "znalosti", "znalosti_ulozit"].includes(akce) && !heroJm) {
      res.status(400).json({ error: "Vyber hrdinu." }); return;
    }
    const hrac = hracZ(body);
    if (["proti", "pool", "patch"].includes(akce) && !hrac) { res.status(400).json({ error: "Chybí ID hráče." }); return; }

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
        if (!T.maUloziste()) { res.status(200).json({ proti: [], pool: null, patch: null }); return; }
        const ids = (await T.redis("SMEMBERS", "proti:seznam")) || [];
        const proti = ids.length ? (await T.redis("MGET", ...ids.map((i) => `proti:${i}`))) : [];
        const [pool, patch] = await Promise.all([T.redis("GET", "pool:posledni"), T.redis("GET", "patch:posledni")]);
        const parse = (v) => { try { return JSON.parse(v); } catch { return null; } };
        res.status(200).json({
          proti: proti.map(parse).filter(Boolean).sort((a, b) => b.datum.localeCompare(a.datum)),
          pool: parse(pool), patch: parse(patch),
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
