"""Gust podobnych widzów (filtrowanie kolaboracyjne item-item) na danych MovieLens 32M.

Dla każdego filmu z katalogu liczymy, jak oceniali go ludzie, którzy oceniali filmy
podobnie jak Ty. Wynik: cf = przewidywane odchylenie od Twojej średniej (w punktach),
cfs = siła dowodu. Dla filmów, które oceniłeś, liczymy bez nich samych (leave-one-out),
żeby model w aplikacji mógł uczciwie nauczyć się wagi tego sygnału.

Dane: F. Maxwell Harper, Joseph A. Konstan. The MovieLens Datasets (GroupLens), do użytku niekomercyjnego.
"""
import io, os, time, urllib.request, zipfile

ML_URL = "https://files.grouplens.org/datasets/movielens/ml-32m.zip"


def _log(*a):
    print(time.strftime("%H:%M:%S"), "[MovieLens]", *a, flush=True)


def compute_cf(ml_dir, my_ratings, catalog_tmdb, max_users=90000, k=40, shrink=60):
    """my_ratings: {tmdb_movie_id: ocena 1-10}; catalog_tmdb: set tmdb id filmów.
    Zwraca {tmdb_id: (cf, cfs)}."""
    import numpy as np
    import pandas as pd
    from scipy import sparse

    os.makedirs(ml_dir, exist_ok=True)
    zpath = os.path.join(ml_dir, "ml-32m.zip")
    if not os.path.exists(zpath) or os.path.getsize(zpath) < 100_000_000:
        _log("pobieram", ML_URL)
        urllib.request.urlretrieve(ML_URL, zpath)
    zf = zipfile.ZipFile(zpath)
    links = pd.read_csv(zf.open("ml-32m/links.csv"), usecols=["movieId", "tmdbId"]).dropna()
    links["tmdbId"] = links["tmdbId"].astype(int)
    m2t = dict(zip(links.movieId, links.tmdbId))
    _log("wczytuję oceny…")
    df = pd.read_csv(zf.open("ml-32m/ratings.csv"), usecols=["userId", "movieId", "rating"],
                     dtype={"userId": "int32", "movieId": "int32", "rating": "float32"})
    df["tmdb"] = df.movieId.map(m2t)
    df = df.dropna(subset=["tmdb"])
    df["tmdb"] = df.tmdb.astype("int64")
    want = set(catalog_tmdb) | set(my_ratings)
    df = df[df.tmdb.isin(want)]
    # próbka aktywnych widzów (≥ 20 ocen) – szybciej, a jakość praktycznie ta sama
    uc = df.userId.value_counts()
    users = uc[uc >= 20].index.values
    rng = np.random.default_rng(42)
    if len(users) > max_users:
        users = rng.choice(users, max_users, replace=False)
    df = df[df.userId.isin(set(users))]
    _log(f"ocen {len(df):,}, widzów {df.userId.nunique():,}, filmów {df.tmdb.nunique():,}")
    # centrowanie po średniej widza
    df["r"] = df.rating - df.groupby("userId").rating.transform("mean")
    items = np.array(sorted(df.tmdb.unique()))
    iidx = {t: i for i, t in enumerate(items)}
    uidx = {u: i for i, u in enumerate(df.userId.unique())}
    rows = df.tmdb.map(iidx).values
    cols = df.userId.map(uidx).values
    X = sparse.csr_matrix((df.r.values.astype("float32"), (rows, cols)), shape=(len(items), len(uidx)))
    B = sparse.csr_matrix((np.ones(len(df), dtype="float32"), (rows, cols)), shape=X.shape)
    norms = np.sqrt(np.asarray(X.multiply(X).sum(axis=1)).ravel()) + 1e-6
    rated = [t for t in my_ratings if t in iidx]
    if len(rated) < 15:
        _log("za mało Twoich filmów w MovieLens:", len(rated))
        return {}
    ri = np.array([iidx[t] for t in rated])
    my = np.array([my_ratings[t] for t in rated], dtype="float32")
    my_c = (my - my.mean()) * 0.5      # skala 1–10 → odchylenie porównywalne z gwiazdkami 0,5–5
    Xr = X[ri].toarray()               # (n_rated × users) gęsto
    Br = B[ri].toarray()
    _log("liczę podobieństwa", Xr.shape, "×", X.shape)
    sim = (X @ Xr.T).T                 # (n_rated × items)
    co = (B @ Br.T).T
    sim = np.asarray(sim) / (norms[ri][:, None] * norms[None, :])
    sim = sim * (np.asarray(co) / (np.asarray(co) + shrink))   # mniej ufamy podobieństwom z małej liczby wspólnych widzów
    out = {}
    rated_pos = {iidx[t]: j for j, t in enumerate(rated)}
    for col, t in enumerate(items):
        if t not in catalog_tmdb and t not in my_ratings:
            continue
        s = sim[:, col].copy()
        if col in rated_pos:
            s[rated_pos[col]] = 0      # leave-one-out
        s[s < 0] = 0
        top = np.argpartition(-s, min(k, len(s) - 1))[:k]
        w = s[top]
        tot = w.sum()
        if tot <= 0.05:
            continue
        cf = float((w * my_c[top]).sum() / (tot + 0.5)) * 2   # z powrotem na skalę 1–10
        out[int(t)] = (round(cf, 2), round(float(tot), 2))
    # „Bliźniacy”: widzowie MovieLens najbardziej podobni do Ciebie (user-user)
    try:
        Xr_s, Br_s = X[ri], B[ri]
        dotu = np.asarray(Xr_s.T @ my_c).ravel()                       # Σ r_ui * moje_i
        nu = np.asarray(Br_s.sum(axis=0)).ravel()                     # liczba wspólnych filmów
        xn = np.sqrt(np.asarray(Xr_s.multiply(Xr_s).sum(axis=0)).ravel()) + 1e-6
        mn = np.sqrt(np.asarray(Br_s.T @ (my_c ** 2)).ravel()) + 1e-6
        simu = dotu / (xn * mn) * (nu / (nu + 12.0))
        simu[nu < 8] = 0
        top = np.argsort(-simu)[:80]
        top = top[simu[top] > 0.05]
        if len(top) >= 10:
            w = simu[top].astype("float32")
            Xt, Bt = X[:, top], B[:, top]
            num = np.asarray(Xt @ w).ravel()
            den = np.asarray(Bt @ w).ravel()
            cnt = np.asarray(Bt.sum(axis=1)).ravel()
            twins = 0
            for col, t in enumerate(items):
                if cnt[col] < 3 or (t not in catalog_tmdb and t not in my_ratings):
                    continue
                ub = float(num[col] / (den[col] + 0.5)) * 2
                twins += 1
                if int(t) in out:
                    cf, cs = out[int(t)]
                    out[int(t)] = (round(0.6 * cf + 0.4 * ub, 2), round(cs + 0.3 * cnt[col], 2))
                else:
                    out[int(t)] = (round(ub, 2), round(0.3 * cnt[col], 2))
            _log(f"bliźniacy: {len(top)} widzów, filmów z ich sygnałem: {twins}")
    except Exception as e:  # nie psuj całości
        _log("bliźniacy: błąd", e)
    _log("gotowe, filmów z sygnałem:", len(out))
    return out
