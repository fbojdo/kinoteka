#!/usr/bin/env python3
"""Kinoteka – nocna aktualizacja danych.

Źródła:
  * Filmweb (nieoficjalne API publicznego profilu) – Twoje oceny i „Chcę zobaczyć",
    oceny Filmwebu dla tytułów z katalogu.
  * TMDB – katalog filmów i seriali, opisy PL, obsada, słowa kluczowe,
    dostępność w serwisach VOD w Polsce (dane JustWatch).
  * IMDb – oficjalny zrzut ocen (datasets.imdbws.com).
  * OMDb (opcjonalnie) – Rotten Tomatoes i Metacritic.
  * Wikidata – nagrody i powiązanie IMDb ↔ Filmweb.

Używa wyłącznie biblioteki standardowej. Konfiguracja przez zmienne środowiskowe:
  TMDB_KEY (wymagany), OMDB_KEY (opcjonalny), FILMWEB_USER (domyślnie Bojryk),
  MIN_VOTES_MOVIE, MIN_VOTES_TV, OMDB_DAILY.
"""
import gzip, io, json, os, re, sys, time, threading, urllib.parse, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
STATE_PATH = os.path.join(ROOT, "state", "state.json.gz")

TMDB_KEY = os.environ.get("TMDB_KEY", "").strip()
OMDB_KEY = os.environ.get("OMDB_KEY", "").strip()
FW_USER = os.environ.get("FILMWEB_USER", "Bojryk").strip()
FW_USER_ID = os.environ.get("FILMWEB_USER_ID", "2570815").strip()   # numer konta Filmweb (Bojryk)
MIN_VOTES_MOVIE = int(os.environ.get("MIN_VOTES_MOVIE", "700"))
MIN_VOTES_TV = int(os.environ.get("MIN_VOTES_TV", "250"))
OMDB_DAILY = int(os.environ.get("OMDB_DAILY", "950"))
FW_RATING_DAILY = int(os.environ.get("FW_RATING_DAILY", "4000"))
TMDB_REFRESH_DAYS = 7
NOW = int(time.time())
UA = "Mozilla/5.0 (Kinoteka personal app; github.com/fbojdo/kinoteka)"

def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)

# ---------------------------------------------------------------- HTTP
_lock = threading.Lock()
_last = {}
STATUS = {"http": {}, "notes": []}

def _err(host, code, url):
    h = STATUS["http"].setdefault(host, {})
    h[str(code)] = h.get(str(code), 0) + 1
    h.setdefault("last_" + str(code), re.sub(r"(api_key|apikey)=[^&]+", r"\1=***", url)[:160])

def http_json(url, headers=None, min_interval=0.0, retries=4, data=None):
    host = urllib.parse.urlparse(url).netloc
    h = {"User-Agent": UA, "Accept": "application/json"}
    if headers:
        h.update(headers)
    for attempt in range(retries):
        if min_interval:
            with _lock:
                wait = _last.get(host, 0) + min_interval - time.time()
                if wait > 0:
                    time.sleep(wait)
                _last[host] = time.time()
        try:
            req = urllib.request.Request(url, headers=h, data=data)
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                if not raw.strip():
                    return None
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            _err(host, e.code, url)
            if e.code == 404:
                return None
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(2 * (attempt + 1) + (int(e.headers.get("Retry-After", "0") or 0)))
                continue
            log("HTTP", e.code, url[:120])
            return None
        except Exception as e:  # noqa
            time.sleep(1.5 * (attempt + 1))
            if attempt == retries - 1:
                _err(host, type(e).__name__, url)
                log("ERR", type(e).__name__, url[:120])
    return None

def pmap(fn, items, workers=8):
    with ThreadPoolExecutor(workers) as ex:
        return list(ex.map(fn, items))

# ---------------------------------------------------------------- state
def load_state():
    if os.path.exists(STATE_PATH):
        with gzip.open(STATE_PATH, "rt", encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_state(st):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with gzip.open(STATE_PATH, "wt", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, separators=(",", ":"))

def write_json(name, obj):
    with open(os.path.join(DATA, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))

# ---------------------------------------------------------------- Filmweb
FW = "https://www.filmweb.pl/api/v1"
FW_H = {"x-locale": "pl_PL"}

def fw_get(path):
    return http_json(FW + path, FW_H, min_interval=0.25)

def fw_user_list(kind, typ):
    """kind: votes | want2see; zwraca [(filmwebId, timestamp)] – pierwsza strona bez parametru page."""
    out, seen, page = [], set(), 1
    key = "votes" if kind == "votes" else "want2Sees"
    while page < 100:
        res = fw_get(f"/users/{FW_USER_ID}/{kind}/{typ}" + ("" if page == 1 else f"?page={page}"))
        items = (res or {}).get(key) or []
        new = 0
        for it in items:
            fid = (it.get("id") or {}).get("id") if isinstance(it.get("id"), dict) else it.get("id") or it.get("entity")
            if isinstance(fid, int) and fid not in seen:
                seen.add(fid); new += 1
                out.append((fid, it.get("timestamp")))
        total = (res or {}).get("totalCount") or 0
        if not new or len(out) >= total:
            break
        page += 1
    return out

def fw_info(fid):
    for p in (f"/title/{fid}/info", f"/film/{fid}/info"):
        r = fw_get(p)
        if r:
            return r
    return None

def fw_rating(fid):
    for p in (f"/film/{fid}/rating", f"/title/{fid}/rating"):
        r = fw_get(p)
        if r and (r.get("rate") or r.get("count")):
            return r
    return None

# ---------------------------------------------------------------- TMDB
TM = "https://api.themoviedb.org/3"

def tm(path, **params):
    if TMDB_KEY.startswith("eyJ"):   # „API Read Access Token" (v4)
        return http_json(f"{TM}{path}?{urllib.parse.urlencode(params)}", {"Authorization": "Bearer " + TMDB_KEY}, min_interval=0.022)
    params["api_key"] = TMDB_KEY
    return http_json(f"{TM}{path}?{urllib.parse.urlencode(params)}", min_interval=0.022)

def tmdb_discover(kind, min_votes):
    ids = []
    for page in range(1, 501):
        r = tm(f"/discover/{kind}", sort_by="vote_count.desc", page=page, **{"vote_count.gte": min_votes})
        if not r or not r.get("results"):
            break
        ids += [x["id"] for x in r["results"]]
        if page >= r.get("total_pages", 0):
            break
    return ids

def tmdb_details(key):
    kind, tid = ("movie" if key[0] == "m" else "tv"), key[1:]
    d = tm(f"/{kind}/{tid}", language="pl-PL",
           append_to_response="credits,keywords,external_ids,watch/providers,translations")
    if not d:
        return None
    crew = d.get("credits", {}).get("crew", [])
    if kind == "movie":
        directors = [c["name"] for c in crew if c.get("job") == "Director"][:3]
        writers = [c["name"] for c in crew if c.get("department") == "Writing"][:3]
        kw = [k["id"] for k in d.get("keywords", {}).get("keywords", [])]
        kwn = {k["id"]: k["name"] for k in d.get("keywords", {}).get("keywords", [])}
        year = (d.get("release_date") or "")[:4]
        runtime = d.get("runtime") or 0
        title, otitle = d.get("title"), d.get("original_title")
        imdb = d.get("imdb_id") or d.get("external_ids", {}).get("imdb_id")
    else:
        directors = [c["name"] for c in d.get("created_by", [])][:3] or \
                    [c["name"] for c in crew if c.get("job") in ("Director", "Executive Producer")][:2]
        writers = [c["name"] for c in crew if c.get("department") == "Writing"][:3]
        kw = [k["id"] for k in d.get("keywords", {}).get("results", [])]
        kwn = {k["id"]: k["name"] for k in d.get("keywords", {}).get("results", [])}
        year = (d.get("first_air_date") or "")[:4]
        rt = d.get("episode_run_time") or []
        runtime = rt[0] if rt else 0
        title, otitle = d.get("name"), d.get("original_name")
        imdb = d.get("external_ids", {}).get("imdb_id")
    overview = d.get("overview") or ""
    if not overview:
        for t in d.get("translations", {}).get("translations", []):
            if t.get("iso_639_1") == "en":
                overview = (t.get("data") or {}).get("overview") or ""
    prov = (d.get("watch/providers", {}).get("results", {}) or {}).get("PL", {}) or {}
    providers = {}
    for typ, code in (("flatrate", "s"), ("free", "f"), ("ads", "a"), ("rent", "r"), ("buy", "b")):
        for p in prov.get(typ, []) or []:
            providers.setdefault(str(p["provider_id"]), code)
            PROVIDERS[str(p["provider_id"])] = [p["provider_name"], p.get("logo_path"), p.get("display_priority", 99)]
    cast = [c["name"] for c in d.get("credits", {}).get("cast", [])[:6]]
    for k, v in kwn.items():
        KEYWORDS[str(k)] = v
    for g in d.get("genres", []):
        GENRES[str(g["id"])] = g["name"]
    return {
        "id": key, "t": title, "ot": otitle if otitle != title else None, "y": int(year) if year.isdigit() else None,
        "g": [g["id"] for g in d.get("genres", [])], "len": runtime or None,
        "p": d.get("poster_path"), "c": [c.get("iso_3166_1") for c in d.get("production_countries", [])] or d.get("origin_country", []),
        "lang": d.get("original_language"), "d": directors, "w": writers, "a": cast, "k": kw[:25],
        "pv": providers, "imdb": imdb, "tr": round(d.get("vote_average") or 0, 1), "tv": d.get("vote_count") or 0,
        "pop": round(d.get("popularity") or 0, 1), "ov": overview,
        "seasons": d.get("number_of_seasons") if kind == "tv" else None,
        "status": d.get("status"), "_ts": NOW,
    }

PROVIDERS, KEYWORDS, GENRES = {}, {}, {}

def tmdb_find_imdb(imdb):
    r = tm(f"/find/{imdb}", external_source="imdb_id")
    if not r:
        return None
    if r.get("movie_results"):
        return "m%d" % r["movie_results"][0]["id"]
    if r.get("tv_results"):
        return "t%d" % r["tv_results"][0]["id"]
    return None

def tmdb_search(title, year, is_tv):
    kind = "tv" if is_tv else "movie"
    params = {"query": title, "language": "pl-PL"}
    if year:
        params["first_air_date_year" if is_tv else "year"] = year
    r = tm(f"/search/{kind}", **params)
    if r and r.get("results"):
        return ("t" if is_tv else "m") + str(r["results"][0]["id"])
    return None

# ---------------------------------------------------------------- IMDb dataset
def imdb_ratings():
    url = "https://datasets.imdbws.com/title.ratings.tsv.gz"
    log("IMDb: pobieram zrzut ocen")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=300) as r:
            raw = gzip.decompress(r.read()).decode("utf-8")
    except Exception as e:
        log("IMDb: błąd", e)
        return {}
    out = {}
    for line in raw.splitlines()[1:]:
        p = line.split("\t")
        if len(p) == 3:
            out[p[0]] = (float(p[1]), int(p[2]))
    log("IMDb: ocen", len(out))
    return out

# ---------------------------------------------------------------- Wikidata
WD = "https://query.wikidata.org/sparql"
AWARD_RULES = [  # (kod, regex po angielskiej nazwie nagrody)
    ("oscar", r"^Academy Award"), ("globe", r"^Golden Globe"), ("bafta", r"^(BAFTA|British Academy (Film|Television))"),
    ("cannes", r"Palme d'Or|Grand Prix \(Cannes|Cannes Film Festival"), ("venice", r"Golden Lion|Venice"),
    ("berlin", r"Golden Bear|Berlin"), ("emmy", r"Emmy"), ("cesar", r"^César"), ("goya", r"^Goya"),
    ("orzel", r"Polish Film Award|Eagle Award"), ("gdynia", r"Gdynia|Golden Lions Award"),
    ("sag", r"Screen Actors Guild"), ("ind", r"Independent Spirit"), ("sundance", r"Sundance"),
]

def wd_query(q):
    data = urllib.parse.urlencode({"query": q, "format": "json"}).encode()
    r = http_json(WD, {"Accept": "application/sparql-results+json",
                       "Content-Type": "application/x-www-form-urlencoded"}, min_interval=1.0, data=data)
    return (r or {}).get("results", {}).get("bindings", [])

def classify_award(label):
    for code, rx in AWARD_RULES:
        if re.search(rx, label or "", re.I):
            return code
    return None

def wikidata_enrich(imdb_ids):
    """Zwraca {imdb: {"fw": filmwebId, "win": [...], "nom": [...], "wl": [etykiety wygranych]}}"""
    out = {}
    ids = sorted(set(i for i in imdb_ids if i))
    for i in range(0, len(ids), 250):
        chunk = ids[i:i + 250]
        vals = " ".join('"%s"' % x for x in chunk)
        q = f"""SELECT ?imdb ?fw ?rel ?awLabel WHERE {{
  VALUES ?imdb {{ {vals} }}
  ?item wdt:P345 ?imdb .
  OPTIONAL {{ ?item wdt:P5032 ?fw . }}
  OPTIONAL {{ {{ ?item wdt:P166 ?aw . BIND("w" AS ?rel) }} UNION {{ ?item wdt:P1411 ?aw . BIND("n" AS ?rel) }}
             ?aw rdfs:label ?awLabel . FILTER(LANG(?awLabel) = "en") }}
}}"""
        for b in wd_query(q):
            im = b["imdb"]["value"]
            e = out.setdefault(im, {"fw": None, "win": set(), "nom": set(), "wl": set()})
            if "fw" in b:
                e["fw"] = b["fw"]["value"]
            if "awLabel" in b:
                code = classify_award(b["awLabel"]["value"])
                if code:
                    (e["win"] if b["rel"]["value"] == "w" else e["nom"]).add(code)
                    if b["rel"]["value"] == "w" and code in ("oscar", "cannes", "venice", "berlin", "globe", "emmy", "bafta"):
                        e["wl"].add(b["awLabel"]["value"])
        if i % 2500 == 0:
            log(f"Wikidata: {i + len(chunk)}/{len(ids)}")
    for e in out.values():
        e["nom"] -= e["win"]
        e["win"], e["nom"], e["wl"] = sorted(e["win"]), sorted(e["nom"]), sorted(e["wl"])[:6]
    return out

def wikidata_imdb_for_filmweb(fw_ids):
    out = {}
    ids = sorted(set(str(x) for x in fw_ids))
    for i in range(0, len(ids), 300):
        vals = " ".join('"%s"' % x for x in ids[i:i + 300])
        q = f"SELECT ?fw ?imdb WHERE {{ VALUES ?fw {{ {vals} }} ?item wdt:P5032 ?fw ; wdt:P345 ?imdb . }}"
        for b in wd_query(q):
            out[b["fw"]["value"]] = b["imdb"]["value"]
    return out

# ---------------------------------------------------------------- OMDb
def omdb(imdb):
    r = http_json(f"https://www.omdbapi.com/?i={imdb}&apikey={OMDB_KEY}", min_interval=0.1)
    if not r or r.get("Response") != "True":
        return {"_ts": NOW}
    res = {"_ts": NOW}
    for x in r.get("Ratings", []):
        if x["Source"] == "Rotten Tomatoes":
            res["rt"] = int(x["Value"].rstrip("%"))
        elif x["Source"] == "Metacritic":
            res["mc"] = int(x["Value"].split("/")[0])
    if r.get("Awards") and r["Awards"] != "N/A":
        res["awt"] = r["Awards"]
    return res

# ---------------------------------------------------------------- main
def entry_fw_id(e):
    return str(e.get("entity") or e.get("id") or e.get("filmId") or e.get("film") or "")

def entry_date(e):
    ts = e.get("timestamp") or e.get("date") or e.get("viewDate")
    if isinstance(ts, (int, float)):
        return time.strftime("%Y-%m-%d", time.gmtime(ts / 1000 if ts > 1e11 else ts))
    if isinstance(ts, str):
        return ts[:10]
    if isinstance(e.get("viewDate"), int):  # YYYYMMDD
        s = str(e["viewDate"])
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    return None

def main():
    if not TMDB_KEY:
        sys.exit("Brak TMDB_KEY – dodaj sekret w ustawieniach repozytorium.")
    os.makedirs(DATA, exist_ok=True)
    st = load_state()
    titles = st.setdefault("titles", {})          # key -> dane TMDB
    fwmap = st.setdefault("fwmap", {})            # filmwebId -> key
    fwinfo = st.setdefault("fwinfo", {})          # filmwebId -> {t,y,tv}
    fwr = st.setdefault("fwr", {})                # filmwebId -> {r,n,_ts}
    om = st.setdefault("omdb", {})                # imdb -> {...}
    wd = st.setdefault("wd", {})                  # imdb -> wikidata
    PROVIDERS.update(st.get("providers", {})); KEYWORDS.update(st.get("keywords", {})); GENRES.update(st.get("genres", {}))

    # 0. Test kluczy
    cfg = tm("/configuration")
    STATUS["tmdb_ok"] = bool(cfg)
    if not cfg:
        STATUS["notes"].append("TMDB nie odpowiada – sprawdź sekret TMDB_KEY (API Key albo Read Access Token).")
    STATUS["tmdb_key_kind"] = "bearer" if TMDB_KEY.startswith("eyJ") else "api_key"
    STATUS["tmdb_key_len"] = len(TMDB_KEY)

    # 1. Filmweb – Twoje listy (publiczne API profilu)
    me = {"user": FW_USER, "ratings": [], "want": []}
    votes_cache = st.setdefault("fwvotes", {})   # "typ:id" -> {r, date, ts}
    fw_counts = {}
    for typ in ("film", "serial"):
        lst = fw_user_list("votes", typ)
        fw_counts["votes/" + typ] = len(lst)
        def get_vote(it, typ=typ):
            fid, ts = it[0], it[1]
            key = f"{typ}:{fid}"
            c = votes_cache.get(key)
            if c and c.get("ts") == ts and c.get("r"):
                return key, c
            v = fw_get(f"/users/{FW_USER_ID}/votes/{typ}/{fid}") or {}
            d = entry_date(v) or entry_date({"timestamp": ts})
            return key, {"r": v.get("rate"), "date": d, "ts": ts, "fav": bool(v.get("favorite") or v.get("favourite"))}
        for key, v in pmap(get_vote, lst, 4):
            votes_cache[key] = v
            if v.get("r"):
                rec = {"fw": key.split(":")[1], "tv": typ == "serial", "r": int(v["r"]), "date": v.get("date")}
                if v.get("fav"):
                    rec["fav"] = True
                me["ratings"].append(rec)
    rated = {r["fw"] for r in me["ratings"]}
    for typ in ("film", "serial"):
        lst = fw_user_list("want2see", typ)
        fw_counts["want/" + typ] = len(lst)
        for fid, ts in lst:
            if str(fid) not in rated:
                me["want"].append({"fw": str(fid), "tv": typ == "serial", "date": entry_date({"timestamp": ts})})
    STATUS["filmweb"] = {"user_id": FW_USER_ID, "counts": fw_counts, "ratings": len(me["ratings"]), "want": len(me["want"])}
    log(f"Filmweb: ocen {len(me['ratings'])}, chcę zobaczyć {len(me['want'])}  {fw_counts}")
    if not me["ratings"] and st.get("me", {}).get("ratings"):
        log("UWAGA: Filmweb nic nie zwrócił – zostawiam poprzednie oceny.")
        STATUS["notes"].append("Filmweb nie zwrócił ocen – użyto poprzednich.")
        me = st["me"]

    # 2. Mapowanie Filmweb -> TMDB
    need = [r for r in me["ratings"] + me["want"] if r["fw"] not in fwmap]
    log("Do zmapowania z Filmwebu:", len(need))
    if need:
        for r in need:
            if not (fwinfo.get(r["fw"]) or {}).get("t"):
                info = fw_info(r["fw"]) or {}
                fwinfo[r["fw"]] = {"t": info.get("originalTitle") or info.get("title"), "pl": info.get("title"),
                                   "y": info.get("year"), "tv": r["tv"]}
        imdb_of = wikidata_imdb_for_filmweb([r["fw"] for r in need])
        def resolve(r):
            fid = r["fw"]
            key = None
            if fid in imdb_of:
                key = tmdb_find_imdb(imdb_of[fid])
            inf = fwinfo.get(fid, {})
            if not key and inf.get("t"):
                key = tmdb_search(inf["t"], inf.get("y"), r["tv"]) or (inf.get("pl") and tmdb_search(inf["pl"], inf.get("y"), r["tv"]))
            return fid, key
        for fid, key in pmap(resolve, need, 6):
            if key:
                fwmap[fid] = key
    for bucket in ("ratings", "want"):
        for r in me[bucket]:
            r["id"] = fwmap.get(r["fw"])
            inf = fwinfo.get(r["fw"]) or {}
            if not r["id"]:
                r["t"], r["y"] = inf.get("pl") or inf.get("t"), inf.get("y")
    log("Niezmapowane:", sum(1 for r in me["ratings"] + me["want"] if not r["id"]))

    # 3. Katalog TMDB
    keys = set()
    for kind, mv, pre in (("movie", MIN_VOTES_MOVIE, "m"), ("tv", MIN_VOTES_TV, "t")):
        ids = tmdb_discover(kind, mv)
        log(f"TMDB discover {kind}: {len(ids)}")
        keys |= {pre + str(i) for i in ids}
    keys |= {r["id"] for r in me["ratings"] + me["want"] if r["id"]}
    if len(keys) < 50 and titles:  # awaria TMDB – nie kasuj katalogu
        keys |= set(titles)
    todo = [k for k in keys if k not in titles or NOW - titles[k].get("_ts", 0) > TMDB_REFRESH_DAYS * 86400]
    todo.sort(key=lambda k: titles.get(k, {}).get("_ts", 0))
    log("TMDB szczegóły do pobrania:", len(todo))
    for i in range(0, len(todo), 500):
        for d in pmap(tmdb_details, todo[i:i + 500], 12):
            if d:
                titles[d["id"]] = d
        log(f"  {min(i + 500, len(todo))}/{len(todo)}")
        if i % 3000 == 0:
            save_state(st)

    # 4. Wikidata (nagrody + id Filmwebu) – dla nowych i co 30 dni
    imdbs = [titles[k]["imdb"] for k in keys if k in titles and titles[k].get("imdb")]
    stale = [i for i in imdbs if i not in wd or NOW - wd[i].get("_ts", 0) > 30 * 86400]
    log("Wikidata do odświeżenia:", len(stale))
    res = wikidata_enrich(stale)
    for i in stale:
        e = res.get(i, {"fw": None, "win": [], "nom": [], "wl": []})
        e["_ts"] = NOW
        wd[i] = e
    for fid, k in fwmap.items():  # z mapowania Twoich ocen też znamy id Filmwebu
        im = titles.get(k, {}).get("imdb")
        if im and im in wd and not wd[im].get("fw"):
            wd[im]["fw"] = fid

    # 5. Oceny Filmwebu dla katalogu
    fw_ids = {}
    for k in keys:
        t = titles.get(k)
        if t and t.get("imdb") and wd.get(t["imdb"], {}).get("fw"):
            fw_ids[k] = wd[t["imdb"]]["fw"]
    for fid, k in fwmap.items():
        fw_ids.setdefault(k, fid)
    fw_todo = [f for f in set(fw_ids.values()) if f not in fwr or NOW - fwr[f].get("_ts", 0) > 14 * 86400]
    fw_todo.sort(key=lambda f: fwr.get(f, {}).get("_ts", 0))
    fw_todo = fw_todo[:FW_RATING_DAILY]
    log("Filmweb oceny do pobrania:", len(fw_todo))
    def get_fwr(f):
        r = fw_rating(f)
        return f, ({"r": round(r.get("rate", 0), 1), "n": r.get("count", 0), "_ts": NOW} if r else {"_ts": NOW})
    for f, v in pmap(get_fwr, fw_todo, 3):
        fwr[f] = v

    # 6. OMDb (RT, Metacritic) – limit dzienny
    if OMDB_KEY:
        cand = sorted({titles[k]["imdb"] for k in keys if k in titles and titles[k].get("imdb")},
                      key=lambda i: (i in om, om.get(i, {}).get("_ts", 0)))
        cand = [i for i in cand if i not in om or NOW - om[i]["_ts"] > 60 * 86400][:OMDB_DAILY]
        log("OMDb do pobrania:", len(cand))
        for i, v in zip(cand, pmap(omdb, cand, 4)):
            om[i] = v

    # 7. IMDb
    imdb = imdb_ratings()
    if imdb:
        st["imdb"] = {k: v for k, v in imdb.items() if k in set(imdbs)}
    imdb = st.get("imdb", {})

    # 8. Zapis danych dla aplikacji
    catalog, overviews = [], {}
    for k in sorted(keys):
        t = titles.get(k)
        if not t:
            continue
        o = {x: y for x, y in t.items() if not x.startswith("_") and x != "ov" and y not in (None, [], {}, "")}
        im = t.get("imdb")
        if im and im in imdb:
            o["ir"], o["iv"] = imdb[im]
        f = fw_ids.get(k)
        if f:
            o["fw"] = f
            if fwr.get(f, {}).get("r"):
                o["fr"], o["fn"] = fwr[f]["r"], fwr[f]["n"]
        if im and im in om:
            for x in ("rt", "mc"):
                if x in om[im]:
                    o[x] = om[im][x]
        w = wd.get(im or "", {})
        if w.get("win"): o["aw"] = w["win"]
        if w.get("nom"): o["an"] = w["nom"]
        if w.get("wl"): o["awl"] = w["wl"]
        if im and om.get(im, {}).get("awt"): o["awt"] = om[im]["awt"]
        catalog.append(o)
        overviews.setdefault(str(hash_shard(k)), {})[k] = t.get("ov", "")
    used_kw = {str(x) for o in catalog for x in o.get("k", [])}
    meta = {
        "updated": time.strftime("%Y-%m-%d %H:%M", time.gmtime()) + " UTC",
        "genres": GENRES, "keywords": {k: v for k, v in KEYWORDS.items() if k in used_kw},
        "providers": {k: v for k, v in PROVIDERS.items()}, "count": len(catalog),
        "sources": {"omdb": bool(OMDB_KEY)},
    }
    os.makedirs(os.path.join(DATA, "ov"), exist_ok=True)
    write_json("catalog.json", catalog)
    write_json("me.json", me)
    write_json("meta.json", meta)
    STATUS["catalog"] = len(catalog)
    STATUS["updated"] = meta["updated"]
    write_json("status.json", STATUS)
    for s, v in overviews.items():
        write_json(f"ov/{s}.json", v)
    st["providers"], st["keywords"], st["genres"], st["me"] = PROVIDERS, KEYWORDS, GENRES, me
    save_state(st)
    log(f"Gotowe: katalog {len(catalog)}, ocen {len(me['ratings'])}, chcę zobaczyć {len(me['want'])}")

def hash_shard(key):
    return int(key[1:]) % 32

if __name__ == "__main__":
    main()
