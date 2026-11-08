// Itemy Divine+ hráčů na hrdinovi a pozici (STRATZ): medián času nákupu a jak často item kupují.
// GET /api/divine?hero=8&pos=1  →  { pozice, zapasu, itemy: [{ id, median_min, podil }] }

const T = require("./_trener.js");

module.exports = async (req, res) => {
  const hero = parseInt(req.query.hero, 10);
  const pos = Math.min(5, Math.max(1, parseInt(req.query.pos, 10) || 1));
  if (!hero) { res.status(400).json({ error: "Chybí ?hero=<id>" }); return; }
  if (!process.env.STRATZ_TOKEN) { res.status(501).json({ error: "Na Vercelu chybí STRATZ_TOKEN." }); return; }
  try {
    const d = await T.cached(`cache:divine_itemy:${hero}:${pos}`, 86400, () => T.stratz(`query I($h: Short!, $hs: [Short]) { heroStats {
        stats(heroIds: $hs, bracketBasicIds: [DIVINE_IMMORTAL], positionIds: [POSITION_${pos}], groupByTime: true, maxTime: 1) { time matchCount }
        itemFullPurchase(heroId: $h, bracketBasicIds: [DIVINE_IMMORTAL], positionIds: [POSITION_${pos}]) { itemId time matchCount instance }
      } }`, { h: hero, hs: [hero] }));
    const zapasu = Math.max(...(d?.heroStats?.stats || []).map((s) => s.matchCount || 0), 0);
    const podleItemu = {};
    for (const x of d?.heroStats?.itemFullPurchase || []) {
      if (x.instance && x.instance > 1) continue;
      (podleItemu[x.itemId] = podleItemu[x.itemId] || []).push(x);
    }
    const itemy = Object.entries(podleItemu).map(([id, rows]) => {
      const n = rows.reduce((a, r) => a + r.matchCount, 0);
      let acc = 0, med = null;
      for (const r of rows.slice().sort((a, b) => a.time - b.time)) { acc += r.matchCount; if (acc >= n / 2) { med = r.time; break; } }
      return { id: Number(id), median_min: med, n, podil: zapasu ? Math.round((1000 * n) / zapasu) / 10 : null };
    }).filter((x) => x.n >= 50).sort((a, b) => b.n - a.n).slice(0, 14);
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=86400");
    res.status(200).json({ pozice: pos, zapasu, itemy });
  } catch (e) {
    res.status(502).json({ error: "STRATZ: " + String((e && e.message) || e) });
  }
};
