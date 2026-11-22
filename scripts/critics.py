"""Krytycy Filmwebu: znajduje 10 krytyków o ocenach najbardziej zbliżonych do Twoich
i zbiera ich oceny dla filmów z katalogu. Dane zbierane przyrostowo (limit zapytań na przebieg).

Korzysta z publicznych endpointów Filmwebu:
  /film/critics                    – panel krytyków (id, nick, redakcja)
  /film/{id}/critics               – którzy krytycy ocenili film
  /film/{id}/critics/rating        – średnia ocena krytyków
  /users/{krytyk}/votes/film/{id}  – ocena konkretnego krytyka
"""
import math


def run(fw_get, pmap, time_left, log, st, my_film_ratings, cand_fids, max_calls=2600):
    """my_film_ratings: {filmwebId(str): ocena}; cand_fids: lista filmwebId z katalogu (wg priorytetu).
    Zwraca (top_critics, per_film) gdzie per_film = {fid: {"avg":..,"n":..,"top":[[rank, ocena],..]}}"""
    C = st.setdefault("critics", {"list": {}, "film": {}, "votes": {}, "avg": {}})
    calls = [0]
    cap = [max_calls - 500]          # 500 zapytań zostaje na średnie krytyków

    def get(path):
        if calls[0] >= cap[0] or time_left() < 14:
            return None
        calls[0] += 1
        return fw_get(path)

    lst = get("/film/critics") or []
    for c in lst:
        C["list"][str(c["id"])] = {"name": c.get("userName"), "pub": c.get("publisher")}
    critics = set(C["list"])
    if not critics:
        return [], {}

    def film_critics(fids):
        need = [f for f in fids if f not in C["film"]]
        for f, r in zip(need, pmap(lambda f: get(f"/film/{f}/critics"), need, 4)):
            if isinstance(r, list):
                C["film"][f] = [str(x) for x in r if str(x) in critics]

    def fetch_votes(pairs):
        pairs = [p for p in pairs if p not in C["votes"]]
        def one(p):
            cid, fid = p.split(":")
            v = get(f"/users/{cid}/votes/film/{fid}")
            return p, (v or {}).get("rate") if v is not None else None
        for i in range(0, len(pairs), 200):
            if calls[0] >= cap[0] or time_left() < 14:
                break
            for p, r in pmap(one, pairs[i:i + 200], 4):
                if r is not None:
                    C["votes"][p] = r
                elif calls[0] < cap[0] and time_left() >= 14:
                    C["votes"][p] = 0       # brak oceny (np. tylko recenzja)

    # 1) Twoje filmy: którzy krytycy je ocenili + ich oceny (najpierw filmy z wyrazistą oceną)
    mine = sorted(my_film_ratings, key=lambda f: -abs(my_film_ratings[f] - 7))
    film_critics(mine)
    fetch_votes([f"{c}:{f}" for f in mine for c in C["film"].get(f, [])])

    # 2) Podobieństwo: korelacja z ostrożnością przy małej liczbie wspólnych filmów
    mu = sum(my_film_ratings.values()) / max(1, len(my_film_ratings))
    sims = []
    for cid in critics:
        pairs = [(my_film_ratings[f], C["votes"].get(f"{cid}:{f}")) for f in mine if C["votes"].get(f"{cid}:{f}")]
        n = len(pairs)
        if n < 6:
            continue
        a = [x for x, _ in pairs]; b = [y for _, y in pairs]
        ma, mb = sum(a) / n, sum(b) / n
        sab = sum((x - ma) * (y - mb) for x, y in pairs)
        sa = math.sqrt(sum((x - ma) ** 2 for x in a)); sb = math.sqrt(sum((y - mb) ** 2 for y in b))
        r = sab / (sa * sb) if sa and sb else 0
        mae = sum(abs(x - y) for x, y in pairs) / n
        agree = sum(1 for x, y in pairs if abs(x - y) <= 1) / n
        score = r * n / (n + 10)
        sims.append({"id": cid, "name": C["list"][cid]["name"], "pub": C["list"][cid]["pub"], "n": n,
                     "corr": round(r, 3), "mae": round(mae, 2), "agree": round(agree, 2), "score": round(score, 3), "mean": round(mb, 2)})
    sims.sort(key=lambda s: -s["score"])
    top = [s for s in sims if s["score"] > 0.15][:10]
    top_ids = [s["id"] for s in top]

    # 3) Filmy z katalogu: oceny Twoich krytyków + średnia krytyków Filmwebu
    if top_ids:
        film_critics(cand_fids[:1500])
        fetch_votes([f"{c}:{f}" for f in cand_fids[:1500] for c in C["film"].get(f, []) if c in top_ids])
    cap[0] = max_calls
    need_avg = [f for f in cand_fids[:3000] if f not in C["avg"]][:max(0, max_calls - calls[0])]
    for f, r in zip(need_avg, pmap(lambda f: get(f"/film/{f}/critics/rating"), need_avg, 4)):
        if r is not None:
            C["avg"][f] = [round(r.get("rate") or 0, 2), r.get("count") or 0]

    per = {}
    for f in set(cand_fids) | set(my_film_ratings):
        d = {}
        if C["avg"].get(f) and C["avg"][f][1]:
            d["avg"], d["n"] = C["avg"][f]
        tv = [[i, C["votes"].get(f"{c}:{f}")] for i, c in enumerate(top_ids) if C["votes"].get(f"{c}:{f}")]
        if tv:
            d["top"] = tv
        if d:
            per[f] = d
    log(f"Krytycy: zapytań {calls[0]}, dopasowanych {len(sims)}, top {len(top)}, filmów z ich ocenami {sum(1 for v in per.values() if 'top' in v)}")
    return top, per
