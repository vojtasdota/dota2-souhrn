// AI trenér – ruční rozbor jednoho zápasu (streamuje text do prohlížeče).
// Protokol odpovědi: řádky začínající \u001d jsou stavové zprávy, na konci za \u001e
// přijde JSON {text, hodnoceni, opravy} s finální (zkontrolovanou) verzí.

const T = require("./_trener.js");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ error: "Použij POST." }); return; }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const { match, hrac, hrdina, heslo, bezReplaye } = body;

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "Na Vercelu chybí proměnná ANTHROPIC_API_KEY." }); return;
  }
  if (process.env.TRENER_HESLO && heslo !== process.env.TRENER_HESLO) {
    res.status(401).json({ error: "Špatné heslo." }); return;
  }
  const matchId = String(match || "").replace(/\D/g, "");
  if (!matchId) { res.status(400).json({ error: "Zadej číslo zápasu." }); return; }

  let zapas, k, ja, data;
  try {
    zapas = await T.odGet(`/matches/${matchId}`);
    if (zapas.version == null && !bezReplaye) {
      await fetch(`${T.OD}/request/${matchId}`, { method: "POST" }).catch(() => {});
      res.status(202).json({ status: "parsing" }); return;
    }
    k = await T.nactiKonstanty();
    ja = T.najdiHrace(zapas, k.heroes, hrac, hrdina);
    data = await T.pripravData(zapas, ja, k);
  } catch (e) {
    const msg = e.code === 404 ? "Zápas nenalezen. Zkontroluj číslo zápasu." : e.message;
    res.status(e.code === 404 ? 404 : 400).json({ error: msg }); return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Hrdina", encodeURIComponent(data.hrac.hrdina));
  res.setHeader("X-Vysledek", encodeURIComponent(data.zapas.vysledek + " · " + data.zapas.delka));

  try {
    // automaticky aktuální guide k hrdinovi, pokud chybí nebo je starý
    if (T.maUloziste()) {
      const nast = await T.nastaveni();
      const zn = await T.znalosti(ja.hero_id).catch(() => null);
      if (nast.autoGuide && T.guideJeStary(zn, nast.guideStariDni)) {
        T.stavRadek(res, `Hledám aktuální guide pro ${data.hrac.hrdina}…`);
        try {
          const { text: guide } = await T.textOnce(T.guideBody(data.hrac.hrdina));
          if (!T.jeChybnyText(guide)) {
            const n = await T.ulozZnalosti(ja.hero_id, { guide, guide_datum: new Date().toISOString() });
            data.znalosti_o_hrdinovi = { moje_poznamky: n.poznamky || null, aktualni_guide: `(${T.dnes()}) ${guide}` };
          }
        } catch { /* bez guidu to půjde taky */ }
      }
    }
    T.stavRadek(res, "Trenér píše rozbor…");

    const vysledek = await T.rozebrat(data, res);
    let ulozeno = false, chybaUlozeni = null;
    if (!T.jeChybnyText(vysledek.text) && T.maUloziste()) {
      try {
        await T.ulozRozbor(T.zaznam(zapas, data, vysledek, {
          hrac: String(hrac || "").trim(), hrdinaZadany: String(hrdina || "").trim(), auto: false,
        }));
        ulozeno = true;
      } catch (e) { chybaUlozeni = e.message; }
    }
    res.write("\u001e" + JSON.stringify({
      text: vysledek.text, hodnoceni: vysledek.hodnoceni, opravy: vysledek.opravy,
      chybaKontroly: vysledek.chybaKontroly || null, ulozeno, chybaUlozeni,
    }));
  } catch (e) {
    res.write("\n\n⚠️ " + e.message);
  }
  res.end();
};
