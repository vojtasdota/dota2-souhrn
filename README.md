# Dota 2 souhrn — web verze (frontend + STRATZ backend)

Statická appka (`index.html`) volá **OpenDotu** přímo z prohlížeče (profily, zápasy,
Protipick, Meta, Svět, Živě, …). Navíc je tu malá **serverless funkce** `api/counters.js`,
která ze serveru volá **STRATZ** a umí countery **filtrované podle ranku** (Ancient+/Divine+),
což z čistého prohlížeče nejde (STRATZ má CORS + tajný token).

V záložce **Hardcounter** je nahoře přepínač **Rank**:
- **Všechny ranky** → jede přes OpenDotu, funguje i bez serveru.
- **Ancient+ / Divine+** → jde přes tvůj backend (`/api/counters`) → STRATZ.

---

## Co budeš potřebovat

1. Účet a **API token na STRATZ**: https://stratz.com/api → přihlásit Steamem → vygenerovat token (zdarma).
2. Účet na **Vercel**: https://vercel.com (zdarma, lze se přihlásit přes GitHub).
3. (Volitelně) účet na **GitHubu** pro pohodlné nasazení.

---

## Nasazení na Vercel — varianta A (přes GitHub, doporučeno)

1. Nahraj celou tuhle složku do nového GitHub repa (např. `dota2-souhrn-web`).
2. Na vercel.com → **Add New… → Project** → naimportuj repo.
3. Framework Preset nech na **Other**. Build/Output nech prázdné (je to statické + `/api`).
4. V **Environment Variables** přidej:
   - Name: `STRATZ_TOKEN`
   - Value: *(tvůj STRATZ token)*
5. **Deploy**. Dostaneš adresu typu `https://tvuj-projekt.vercel.app`.

## Nasazení — varianta B (přes Vercel CLI)

```bash
npm i -g vercel
cd dota-web
vercel            # první deploy (preview)
vercel env add STRATZ_TOKEN     # vlož token
vercel --prod     # produkční deploy
```

---

## Otestování

- Otevři nasazenou adresu → **Hardcounter** → nech „Všechny ranky" a klikni hrdinu.
  Když to jede, OpenDota část funguje.
- Přepni **Rank** na **Divine+** a klikni hrdinu. Tím se zavolá tvůj backend → STRATZ.
- Rychlý test backendu přímo v prohlížeči:
  `https://tvuj-projekt.vercel.app/api/counters?hero=8&bracket=divine_immortal`
  (hero=8 je Juggernaut). Má vrátit JSON pole `[{hero_id, games_played, wins}, …]`.

---

## Když STRATZ vrátí chybu (důležité)

GraphQL dotaz v `api/counters.js` je psaný podle dokumentace, ale **přesné názvy polí
jsem nemohl ověřit naživo**. Pokud `/api/counters` vrací `STRATZ GraphQL chyba`, oprav
dotaz proti živému schématu:

1. Otevři **https://api.stratz.com/graphiql** a vlož svůj token (tlačítko pro Authorization,
   hodnota `Bearer TVUJ_TOKEN`).
2. Zkus dotaz z `QUERY` v `api/counters.js`. GraphiQL ti našeptá správné názvy.
   Nejčastější věci k ověření:
   - `heroStats.matchUp` vs. `heroStats.heroVsHeroMatchup`
   - argument `heroId` (skalár `Short` vs. pole `[Short]`)
   - `bracketBasicIds` a hodnoty enumu (`RankBracketBasicEnum`: např. `DIVINE_IMMORTAL`,
     `LEGEND_ANCIENT`, …)
   - názvy polí ve `vs`: `heroId2`, `matchCount`, `winCount`
3. Uprav `QUERY` a mapu `BRACKETS` v `api/counters.js`, ulož, znovu deployni.

Backend schválně vrací výsledek ve **stejném tvaru jako OpenDota**
(`[{hero_id, games_played, wins}]`), takže frontend není potřeba měnit — stačí doladit
ten jeden GraphQL dotaz.

---

## Pozn. k bracketům

STRATZ „basic" brackety sdružují vždy dvě medaile, takže **čistě „Ancient"** se izolovat
nedá — proto je „Ancient+" v praxi *Legend–Immortal* a „Divine+" je *Divine–Immortal*.
Když budeš chtít jiné dělení, uprav mapu `BRACKETS` v `api/counters.js`.

---

## Lokální vývoj (volitelné)

```bash
npm i -g vercel
vercel dev        # spustí frontend i /api lokálně na http://localhost:3000
```
Token vezme z `.env` (zkopíruj `.env.example` → `.env` a vlož token).
