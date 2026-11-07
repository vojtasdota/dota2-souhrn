// Hledání hráčů podle jména přes OpenDotu s cache na Vercel edge –
// opakovaná a populární jména se vrací okamžitě a nešetří se limit OpenDoty.
module.exports = async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 64);
  if (q.length < 2) { res.status(400).json({ error: "Zadej aspoň 2 znaky." }); return; }
  try {
    const r = await fetch("https://api.opendota.com/api/search?q=" + encodeURIComponent(q), {
      headers: { "User-Agent": "dota2-souhrn" },
    });
    if (!r.ok) { res.status(r.status).json({ error: "OpenDota vrátila " + r.status }); return; }
    const data = await r.json();
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json(Array.isArray(data) ? data : []);
  } catch (e) {
    res.status(502).json({ error: "Hledání selhalo: " + String((e && e.message) || e) });
  }
};
