// AI trenér – ruční rozbor jednoho zápasu (streamuje text do prohlížeče).
// Veškerá logika je v api/_trener.js.

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

  let zapas, k, ja;
  try {
    zapas = await T.odGet(`/matches/${matchId}`);
    if (zapas.version == null && !bezReplaye) {
      await fetch(`${T.OD}/request/${matchId}`, { method: "POST" }).catch(() => {});
      res.status(202).json({ status: "parsing" }); return;
    }
    k = await T.nactiKonstanty();
    ja = T.najdiHrace(zapas, k.heroes, hrac, hrdina);
  } catch (e) {
    res.status(e.code === 404 ? 404 : 400).json({ error: e.message }); return;
  }

  const data = T.shrnuti(zapas, ja, k);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Hrdina", encodeURIComponent(data.hrac.hrdina));
  res.setHeader("X-Vysledek", encodeURIComponent(data.zapas.vysledek + " · " + data.zapas.delka));
  try {
    const { text } = await T.streamClaude(data, res);
    if (!T.jeChybnyText(text)) {
      await T.ulozRozbor({
        match: matchId, hrac: String(hrac || "").trim(), hrdinaZadany: String(hrdina || "").trim(),
        hrdina: data.hrac.hrdina, vysledek: data.zapas.vysledek + " · " + data.zapas.delka,
        hrano: zapas.start_time, datum: new Date().toISOString(), auto: false, text,
      }).catch((e) => res.write(`\n\n_(Pozn.: rozbor se nepodařilo uložit na server: ${e.message})_`));
    }
  } catch (e) {
    res.write("\n\n⚠️ " + e.message);
  }
  res.end();
};
