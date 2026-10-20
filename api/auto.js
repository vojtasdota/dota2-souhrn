// AI trenér – automatika.
//  GET  (Vercel Cron, 1× denně): najde tvoje nové zápasy, nechá je rozparsovat, rozebere a uloží.
//  POST {akce:"seznam"}  – vrátí uložené rozbory pro stránku
//  POST {akce:"sync"}    – totéž co cron, spouští ho stránka při otevření
//  POST {akce:"smazat", klic} – smaže jeden rozbor

const T = require("./_trener.js");

const pockej = (ms) => new Promise((r) => setTimeout(r, ms));
const NAJEDNOU = 3; // kolik rozborů max. v jednom běhu (časový limit funkce je 5 min)

async function sync(hrac) {
  const start = Date.now();
  const out = { nove: 0, rozebrano: [], ceka: [], chyby: [], limit: false, bezi: false };

  const zamek = await T.redis("SET", "trener:zamek", "1", "NX", "EX", "300");
  if (zamek !== "OK") return { ...out, bezi: true };

  try {
    // automatika bere jen zápasy od prvního spuštění (minus 1 den), ať nerozebírá celou historii
    let od = await T.redis("GET", "trener:od");
    if (!od) { od = String(Math.floor(Date.now() / 1000) - 86400); await T.redis("SET", "trener:od", od); }

    const seznam = await T.odGet(`/players/${hrac}/matches?limit=20&date=3`);
    const kandidati = (Array.isArray(seznam) ? seznam : [])
      .filter((z) => z.start_time >= Number(od) && (z.duration || 0) >= 600);
    const klice = kandidati.map((z) => T.klicRozboru(z.match_id, hrac));
    const existuji = klice.length ? await T.redis("MGET", ...klice) : [];
    const vynechat = await T.smazane();
    let nove = kandidati.filter((_, i) => !existuji[i] && !vynechat.has(klice[i]))
      .sort((a, b) => b.start_time - a.start_time);
    out.nove = nove.length;
    if (!nove.length) return out;

    // denní limit, ať automatika neprojí kredit
    const den = new Date().toISOString().slice(0, 10);
    const hotovo = Number((await T.redis("GET", `trener:denne:${den}`)) || 0);
    const zbyva = Math.max(0, Number(process.env.TRENER_MAX_DENNE || 5) - hotovo);
    if (nove.length > zbyva) out.limit = true;
    nove = nove.slice(0, zbyva);
    if (!nove.length) return out;

    // stáhnout zápasy, u nerozparsovaných požádat OpenDotu o zpracování
    let pripravene = [], cekajici = [];
    for (const z of nove) {
      const m = await T.odGet(`/matches/${z.match_id}`);
      if (m.version != null) pripravene.push(m);
      else {
        await fetch(`${T.OD}/request/${z.match_id}`, { method: "POST" }).catch(() => {});
        cekajici.push(z.match_id);
      }
    }
    // chvíli počkat, jestli se něco stihne rozparsovat
    while (cekajici.length && pripravene.length < NAJEDNOU && Date.now() - start < 75000) {
      await pockej(15000);
      for (const id of [...cekajici]) {
        const m = await T.odGet(`/matches/${id}`);
        if (m.version != null) { pripravene.push(m); cekajici = cekajici.filter((x) => x !== id); }
      }
    }

    const ted = pripravene.slice(0, NAJEDNOU);
    out.ceka = [...cekajici, ...pripravene.slice(NAJEDNOU).map((m) => m.match_id)];

    const k = await T.nactiKonstanty();
    await Promise.all(ted.map(async (m) => {
      try {
        const ja = T.najdiHrace(m, k.heroes, hrac);
        const data = await T.pripravData(m, ja, k);
        const { text } = await T.claudeText(data);
        if (T.jeChybnyText(text)) throw new Error("AI vrátila prázdný rozbor");
        await T.ulozRozbor({
          match: String(m.match_id), hrac: String(hrac), hrdinaZadany: "",
          hrdina: data.hrac.hrdina, vysledek: data.zapas.vysledek + " · " + data.zapas.delka,
          hrano: m.start_time, datum: new Date().toISOString(), auto: true, text,
        });
        await T.redis("INCR", `trener:denne:${den}`);
        await T.redis("EXPIRE", `trener:denne:${den}`, "172800");
        out.rozebrano.push({ match: m.match_id, hrdina: data.hrac.hrdina });
      } catch (e) {
        out.chyby.push(`${m.match_id}: ${e.message}`);
      }
    }));
    return out;
  } finally {
    await T.redis("DEL", "trener:zamek").catch(() => {});
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (!T.maUloziste()) {
    res.status(501).json({ error: "Úložiště není nastavené (připoj Upstash Redis ve Vercelu → Storage).", bezUloziste: true });
    return;
  }

  // --- Vercel Cron
  if (req.method === "GET") {
    const auth = req.headers.authorization || "";
    const ok = process.env.CRON_SECRET
      ? auth === `Bearer ${process.env.CRON_SECRET}`
      : /vercel-cron/i.test(req.headers["user-agent"] || "");
    if (!ok) { res.status(401).json({ error: "Nepovoleno." }); return; }
    if (!process.env.TRENER_HRAC) { res.status(400).json({ error: "Chybí TRENER_HRAC." }); return; }
    if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "Chybí ANTHROPIC_API_KEY." }); return; }
    try { res.status(200).json(await sync(process.env.TRENER_HRAC)); }
    catch (e) { res.status(500).json({ error: e.message }); }
    return;
  }

  // --- stránka trenéra
  if (req.method !== "POST") { res.status(405).json({ error: "Použij POST." }); return; }
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  if (process.env.TRENER_HESLO && body.heslo !== process.env.TRENER_HESLO) {
    res.status(401).json({ error: "Špatné heslo." }); return;
  }

  try {
    if (body.akce === "seznam") {
      res.status(200).json({ rozbory: await T.seznamRozboru(), hrac: process.env.TRENER_HRAC || null });
    } else if (body.akce === "smazat") {
      if (!/^rozbor:/.test(body.klic || "")) { res.status(400).json({ error: "Špatný klíč." }); return; }
      await T.smazRozbor(body.klic);
      res.status(200).json({ ok: true });
    } else if (body.akce === "sync") {
      const hrac = process.env.TRENER_HRAC || String(body.hrac || "").replace(/\D/g, "");
      if (!hrac) { res.status(400).json({ error: "Chybí ID hráče (TRENER_HRAC)." }); return; }
      if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "Chybí ANTHROPIC_API_KEY." }); return; }
      res.status(200).json(await sync(hrac));
    } else {
      res.status(400).json({ error: "Neznámá akce." });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
