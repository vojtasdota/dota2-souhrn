#!/usr/bin/env python3
"""
Dota 2 AI trenér
================
Stáhne data zápasu z OpenDota (včetně rozparsovaného replaye), vytáhne
klíčové momenty pro zvoleného hráče a nechá Clauda napsat trenérský rozbor:
co jsi dělal dobře, co špatně a na čem zapracovat.

Instalace:
    pip install requests anthropic

API klíč (https://console.anthropic.com):
    Windows (PowerShell):  $env:ANTHROPIC_API_KEY="sk-ant-..."
    Linux / macOS:         export ANTHROPIC_API_KEY="sk-ant-..."

Použití:
    python dota_trener.py <MATCH_ID> --hrac <TVOJE_ACCOUNT_ID>
    python dota_trener.py <MATCH_ID> --hrdina "Anti-Mage"
    python dota_trener.py <MATCH_ID> --hrac 123456789 --jen-data   (bez AI, zdarma)
"""

import argparse
import json
import os
import sys
import time

import requests

API = "https://api.opendota.com/api"
STEAM64_OFFSET = 76561197960265728
ROLE = {1: "safe lane (carry)", 2: "mid", 3: "offlane", 4: "jungle"}


# ---------------------------------------------------------------- OpenDota

def get(path, **params):
    r = requests.get(f"{API}{path}", params=params, timeout=30)
    if r.status_code == 404:
        sys.exit("Zápas nenalezen. Zkontroluj match ID.")
    r.raise_for_status()
    return r.json()


def je_rozparsovany(zapas):
    return zapas.get("version") is not None


def nacti_zapas(match_id):
    print(f"Stahuji zápas {match_id}...")
    zapas = get(f"/matches/{match_id}")
    if je_rozparsovany(zapas):
        return zapas

    print("Replay ještě není rozparsovaný, žádám OpenDota o zpracování (může trvat pár minut)...")
    requests.post(f"{API}/request/{match_id}", timeout=30)
    for _ in range(24):  # max ~6 minut
        time.sleep(15)
        zapas = get(f"/matches/{match_id}")
        if je_rozparsovany(zapas):
            print("Hotovo.")
            return zapas
        print("  pořád čekám...")
    print("Varování: replay se nepodařilo rozparsovat (možná už vypršel na serverech Valve).\n"
          "Rozbor bude jen ze základních statistik.")
    return zapas


# ---------------------------------------------------------------- pomocné

def cas(sekundy):
    sekundy = int(sekundy)
    znak = "-" if sekundy < 0 else ""
    m, s = divmod(abs(sekundy), 60)
    return f"{znak}{m}:{s:02d}"


def v_minute(rada, minuta):
    if rada and len(rada) > minuta:
        return rada[minuta]
    return None


def najdi_hrace(zapas, heroes, account_id=None, hrdina=None):
    hraci = zapas["players"]
    if account_id is not None:
        if account_id > STEAM64_OFFSET:  # zadané 64bitové Steam ID
            account_id -= STEAM64_OFFSET
        for p in hraci:
            if p.get("account_id") == account_id:
                return p
        sys.exit("Hráč s tímto ID v zápase není (nebo má skrytý profil). Zkus --hrdina.")
    if hrdina:
        hledany = hrdina.lower().replace("-", "").replace(" ", "")
        for p in hraci:
            jmeno = heroes[str(p["hero_id"])]["localized_name"].lower().replace("-", "").replace(" ", "")
            if hledany in jmeno:
                return p
        sys.exit(f"Hrdina '{hrdina}' v zápase není.")
    sys.exit("Zadej --hrac nebo --hrdina.")


def je_radiant(p):
    return p["player_slot"] < 128


def soupers_na_lajne(zapas, ja):
    """Nepřátelé, kteří stáli proti mně na lajně."""
    proti = {1: 3, 3: 1, 2: 2}.get(ja.get("lane_role"))
    return [p for p in zapas["players"]
            if je_radiant(p) != je_radiant(ja) and p.get("lane_role") == proti]


# ---------------------------------------------------------------- shrnutí

def shrnuti(zapas, ja, heroes, items):
    jm = lambda p: heroes[str(p["hero_id"])]["localized_name"]
    muj_npc = heroes[str(ja["hero_id"])]["name"]
    radiant = je_radiant(ja)
    vyhra = zapas["radiant_win"] == radiant
    d = {}

    d["zapas"] = {
        "delka": cas(zapas["duration"]),
        "vysledek": "VÝHRA" if vyhra else "PROHRA",
        "skore_muj_tym_vs_souper": (
            f"{zapas['radiant_score']}:{zapas['dire_score']}" if radiant
            else f"{zapas['dire_score']}:{zapas['radiant_score']}"),
        "muj_tym": [jm(p) for p in zapas["players"] if je_radiant(p) == radiant],
        "souperi": [jm(p) for p in zapas["players"] if je_radiant(p) != radiant],
        "replay_rozparsovany": je_rozparsovany(zapas),
    }

    d["hrac"] = {
        "hrdina": jm(ja),
        "role": "roaming" if ja.get("is_roaming") else ROLE.get(ja.get("lane_role"), "neznámá"),
        "KDA": f"{ja['kills']}/{ja['deaths']}/{ja['assists']}",
        "level": ja.get("level"),
        "last_hits": ja.get("last_hits"), "denies": ja.get("denies"),
        "GPM": ja.get("gold_per_min"), "XPM": ja.get("xp_per_min"),
        "net_worth": ja.get("net_worth"),
        "hero_damage": ja.get("hero_damage"), "tower_damage": ja.get("tower_damage"),
        "hero_healing": ja.get("hero_healing"),
        "ucast_v_teamfightech_pct": round(100 * ja["teamfight_participation"])
            if ja.get("teamfight_participation") is not None else None,
        "efektivita_lajny_pct": ja.get("lane_efficiency_pct"),
        "staky_campu": ja.get("camps_stacked"),
        "observer_wardy": ja.get("obs_placed"), "sentry_wardy": ja.get("sen_placed"),
        "stuny_sekund": round(ja["stuns"], 1) if ja.get("stuns") else None,
        "APM": ja.get("actions_per_min"),
        "buybacky": [cas(b["time"]) for b in ja.get("buyback_log") or []],
    }

    # srovnání s ostatními hráči na stejném hrdinovi (percentily)
    if ja.get("benchmarks"):
        d["percentil_vs_stejny_hrdina"] = {
            k: f"{round(v['pct'] * 100)}. percentil (hodnota {round(v['raw'], 2)})"
            for k, v in ja["benchmarks"].items() if v.get("pct") is not None}

    # lajna: CS a zlato v 5. a 10. minutě, srovnání se soupeřem na lajně
    lajna = {}
    for m in (5, 10):
        lajna[f"{m}min"] = {
            "ja_LH": v_minute(ja.get("lh_t"), m), "ja_DN": v_minute(ja.get("dn_t"), m),
            "ja_zlato": v_minute(ja.get("gold_t"), m),
            "souperi": {jm(s): {"LH": v_minute(s.get("lh_t"), m),
                                "zlato": v_minute(s.get("gold_t"), m)}
                        for s in soupers_na_lajne(zapas, ja)},
        }
    d["lajna"] = lajna

    # průběh networthu: já vs. průměr nepřátel
    nepratele = [p for p in zapas["players"] if je_radiant(p) != radiant]
    prubeh = {}
    for m in range(10, zapas["duration"] // 60 + 1, 5):
        moje = v_minute(ja.get("gold_t"), m)
        jejich = [v_minute(p.get("gold_t"), m) for p in nepratele]
        jejich = [x for x in jejich if x is not None]
        if moje is not None and jejich:
            prubeh[f"{m}min"] = {"ja": moje, "prumer_nepratel": round(sum(jejich) / len(jejich))}
    d["zlato_v_case"] = prubeh

    # nákupy dražších itemů (bez spotřebáku a receptů)
    nakupy = []
    for n in ja.get("purchase_log") or []:
        it = items.get(n["key"], {})
        if n["key"].startswith("recipe_") or (it.get("cost") or 0) < 1000:
            continue
        nakupy.append(f"{cas(n['time'])} {it.get('dname', n['key'])}")
    d["klicove_nakupy"] = nakupy
    tp = (ja.get("purchase") or {}).get("tpscroll")
    d["koupenych_TP"] = tp

    # smrti: kdy, kdo zabil, jestli šlo o teamfight
    fighty = zapas.get("teamfights") or []
    smrti = []
    for p in zapas["players"]:
        for k in p.get("kills_log") or []:
            if k["key"] == muj_npc:
                t = k["time"]
                v_tf = any(f["start"] - 5 <= t <= f["end"] + 5 for f in fighty)
                smrti.append((t, jm(p), v_tf))
    smrti.sort()
    d["smrti"] = [f"{cas(t)} zabil {kdo}" + (" (během teamfightu)" if tf else " (MIMO teamfight – pick-off)")
                  for t, kdo, tf in smrti]
    zbyle = ja["deaths"] - len(smrti)
    if zbyle > 0:
        d["smrti_ostatni"] = f"{zbyle}× smrt od creepů/věží/neutrálů"

    d["moje_killy_casy"] = [cas(k["time"]) for k in ja.get("kills_log") or []]

    # finální build
    d["finalni_itemy"] = [items_by_id(items).get(ja.get(f"item_{i}"), "") for i in range(6)]
    d["finalni_itemy"] = [x for x in d["finalni_itemy"] if x]
    return d


_items_cache = {}
def items_by_id(items):
    if not _items_cache:
        for v in items.values():
            if "id" in v:
                _items_cache[v["id"]] = v.get("dname", "")
    return _items_cache


# ---------------------------------------------------------------- Claude

SYSTEM = """Jsi zkušený trenér Doty 2 (úroveň profesionálního analytika). Dostaneš data
z jednoho zápasu hráče. Napiš česky konkrétní a upřímný rozbor:

1. Celkové hodnocení (2–3 věty, známka 1–10 za výkon v dané roli).
2. Co šlo dobře – konkrétně, s čísly a časy.
3. Největší chyby – 3 až 5 nejdůležitějších, seřazené podle dopadu. U každé: co se stalo
   (s časem), proč je to problém a co dělat příště.
4. Build – byl rozumný vůči soupeřům? Byly klíčové itemy načasované dobře?
5. Na co se zaměřit v příštích hrách – 1 až 2 konkrétní cvičení nebo návyky.

Pravidla: Vycházej jen z dat, nevymýšlej si situace, které z nich nevyplývají.
Nemáš k dispozici pozice na mapě, takže u smrtí mluv o pravděpodobných příčinách,
ne o jistotách. Percentily jsou srovnání s ostatními hráči stejného hrdiny.
Buď přímý jako dobrý trenér, ne zbytečně pochvalný, ale ani zlý."""


def rozbor(data, model):
    import anthropic
    client = anthropic.Anthropic()
    text = ""
    # streamování: rozbor se vypisuje průběžně a dlouhá odpověď se neusekne
    with client.messages.stream(
        model=model,
        max_tokens=32000,
        system=SYSTEM,
        messages=[{"role": "user",
                   "content": "Data ze zápasu:\n\n" + json.dumps(data, ensure_ascii=False, indent=2)}],
    ) as stream:
        for kus in stream.text_stream:
            print(kus, end="", flush=True)
            text += kus
        msg = stream.get_final_message()
    print()
    if msg.stop_reason == "max_tokens":
        print("\n!! Rozbor byl useknutý kvůli limitu délky.")
    if not text.strip() or msg.stop_reason not in ("end_turn", "stop_sequence"):
        print("!! Diagnostika (pošli ji do chatu):")
        print("   model:", model)
        print("   stop_reason:", msg.stop_reason)
        print("   typy bloků:", [b.type for b in msg.content])
        print("   usage:", msg.usage)
    return text


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="AI rozbor Dota 2 zápasu")
    ap.add_argument("match_id", type=int)
    ap.add_argument("--hrac", type=int, help="tvoje Dota account ID (Friend ID) nebo Steam64 ID")
    ap.add_argument("--hrdina", help="jméno hrdiny, kterého jsi hrál (když máš skrytý profil)")
    ap.add_argument("--jen-data", action="store_true", help="jen vypsat data, nevolat AI")
    ap.add_argument("--model", default="claude-sonnet-5-5")
    a = ap.parse_args()

    if not a.jen_data and not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("Chybí proměnná ANTHROPIC_API_KEY (nebo použij --jen-data).")

    zapas = nacti_zapas(a.match_id)
    heroes = get("/constants/heroes")
    items = get("/constants/items")
    ja = najdi_hrace(zapas, heroes, a.hrac, a.hrdina)
    data = shrnuti(zapas, ja, heroes, items)

    if a.jen_data:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return

    print(f"Analyzuji výkon na {data['hrac']['hrdina']}...\n")
    text = rozbor(data, a.model)
    soubor = f"rozbor_{a.match_id}.md"
    with open(soubor, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"\nRozbor uložen do {soubor}")


if __name__ == "__main__":
    main()
