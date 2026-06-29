// Serverless proxy: rank-filtered hero matchups from STRATZ.
// Returns an OpenDota-compatible shape: [{ hero_id, games_played, wins }]
// so the frontend can treat STRATZ and OpenDota data identically.
//
// Env var required on the server (Vercel → Project → Settings → Environment Variables):
//   STRATZ_TOKEN = <your STRATZ API bearer token from https://stratz.com/api>
//
// NOTE: STRATZ's GraphQL schema names below (matchUp / bracketBasicIds / winCount …)
// are my best guess from their docs. If a request fails, open
// https://api.stratz.com/graphiql, paste the QUERY, and fix the field/arg names.
// Everything else can stay the same — this file is the only place to tweak.

const STRATZ_URL = "https://api.stratz.com/graphql";

// Map our bracket keys -> STRATZ RankBracketBasicEnum values.
// STRATZ "basic" brackets group two medals together, so true "Ancient only"
// is not isolable; we approximate Ancient+ as Legend→Immortal.
const BRACKETS = {
  legend_ancient:  ["LEGEND_ANCIENT", "DIVINE_IMMORTAL"], // ≈ Ancient+ (Legend–Immortal)
  divine_immortal: ["DIVINE_IMMORTAL"],                   // ≈ Divine+  (Divine–Immortal)
};

const QUERY = `
query Matchups($heroId: [Short], $brackets: [RankBracketBasicEnum]) {
  heroStats {
    matchUp(heroId: $heroId, bracketBasicIds: $brackets) {
      heroId
      vs {
        heroId2
        matchCount
        winCount
      }
    }
  }
}`;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const token = process.env.STRATZ_TOKEN;
  if (!token) {
    res.status(500).json({ error: "Chybí STRATZ_TOKEN v env proměnných serveru." });
    return;
  }

  const hero = parseInt(req.query.hero, 10);
  const bracketKey = String(req.query.bracket || "divine_immortal");
  const brackets = BRACKETS[bracketKey] || BRACKETS.divine_immortal;
  if (!hero) { res.status(400).json({ error: "Chybí ?hero=<id>" }); return; }

  try {
    const r = await fetch(STRATZ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        "User-Agent": "STRATZ_API",
      },
      body: JSON.stringify({ query: QUERY, variables: { heroId: [hero], brackets } }),
    });

    if (!r.ok) {
      const t = await r.text();
      res.status(r.status).json({ error: "STRATZ vrátil " + r.status, detail: t.slice(0, 600) });
      return;
    }

    const j = await r.json();
    if (j.errors) {
      res.status(502).json({ error: "STRATZ GraphQL chyba (zkontroluj názvy polí v GraphiQL)", detail: j.errors });
      return;
    }

    const mu = j.data && j.data.heroStats && j.data.heroStats.matchUp;
    const entry = Array.isArray(mu) ? (mu.find(e => e && e.heroId === hero) || mu[0]) : mu;
    const vs = (entry && entry.vs) || [];

    const out = vs
      .filter(v => v && v.heroId2 != null && v.matchCount > 0)
      .map(v => ({ hero_id: v.heroId2, games_played: v.matchCount, wins: v.winCount || 0 }));

    // Cache on Vercel's edge for a day so we don't hammer STRATZ.
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=86400");
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: "Proxy selhal", detail: String((e && e.message) || e) });
  }
};
