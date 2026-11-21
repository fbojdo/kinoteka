/* Kinoteka – katalog filmów i seriali z rekomendacjami uczącymi się na Twoich ocenach. */
'use strict';

const IMG = 'https://image.tmdb.org/t/p/';
const LS_KEY = 'kinoteka.v1';
const AWARDS = {
  oscar: 'Oscar', globe: 'Złoty Glob', bafta: 'BAFTA', cannes: 'Cannes', venice: 'Wenecja', berlin: 'Berlinale',
  emmy: 'Emmy', cesar: 'César', goya: 'Goya', orzel: 'Orły', gdynia: 'Gdynia', sag: 'SAG', ind: 'Spirit', sundance: 'Sundance'
};
const COUNTRY = { PL: 'Polska', US: 'USA', GB: 'Wielka Brytania', FR: 'Francja', DE: 'Niemcy', IT: 'Włochy', ES: 'Hiszpania',
  JP: 'Japonia', KR: 'Korea Płd.', SE: 'Szwecja', DK: 'Dania', NO: 'Norwegia', CA: 'Kanada', AU: 'Australia', IE: 'Irlandia',
  BE: 'Belgia', MX: 'Meksyk', IN: 'Indie', CN: 'Chiny', HK: 'Hongkong', IR: 'Iran', AR: 'Argentyna', BR: 'Brazylia', NZ: 'Nowa Zelandia',
  CZ: 'Czechy', HU: 'Węgry', RU: 'Rosja', IS: 'Islandia', FI: 'Finlandia', NL: 'Holandia', AT: 'Austria', CH: 'Szwajcaria', IL: 'Izrael', TR: 'Turcja' };

/* ------------------------------------------------------------------ stan */
const S = {
  cat: [], byId: new Map(), meta: {}, me: { ratings: [], want: [] },
  local: { ratings: {}, want: {}, hidden: {}, subs: [], predlog: {}, filters: null },
  myRatings: new Map(),   // id -> {r, date, src}
  model: null, preds: new Map(), reasons: new Map(),
  tab: 'rec', q: '', limit: 40,
  f: null,
};
const DEFAULT_F = () => ({
  type: 'all', genres: [], yFrom: 1920, yTo: 2030, rtMax: 0, provs: [], onlySubs: false, awards: [], awardMode: 'win',
  minFw: 0, minImdb: 0, minRt: 0, minMc: 0, minVotes: 0, country: '', hideSeen: true, sort: 'match'
});

function loadLocal() {
  try { Object.assign(S.local, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) { /* tryb prywatny */ }
  S.f = Object.assign(DEFAULT_F(), S.local.filters || {});
}
let saveT;
function saveLocal() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    S.local.filters = S.f;
    try { localStorage.setItem(LS_KEY, JSON.stringify(S.local)); } catch (e) { /* pełny */ }
  }, 150);
}

/* ------------------------------------------------------------------ pomocnicze */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x, d = 1) => x == null ? '–' : Number(x).toFixed(d).replace('.', ',');
const kfmt = n => n >= 1e6 ? fmt(n / 1e6) + ' mln' : n >= 1e3 ? Math.round(n / 1e3) + ' tys.' : String(n);
const genreName = id => (S.meta.genres || {})[id] || '';
const provInfo = id => (S.meta.providers || {})[id];
const today = () => new Date().toISOString().slice(0, 10);

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(url + ' ' + r.status);
  return r.json();
}

/* ------------------------------------------------------------------ dane */
async function load() {
  loadLocal();
  try {
    const [cat, meta, me] = await Promise.all([getJSON('data/catalog.json'), getJSON('data/meta.json'), getJSON('data/me.json')]);
    S.cat = cat; S.meta = meta; S.me = me;
  } catch (e) {
    $('#view').innerHTML = `<div class="empty">Brak danych katalogu.<br><small>Pierwsza aktualizacja w GitHub Actions jeszcze się nie zakończyła albo brakuje klucza TMDB.</small></div>`;
    return;
  }
  for (const t of S.cat) S.byId.set(t.id, t);
  mergeRatings();
  buildModel();
  render();
}

function mergeRatings() {
  S.myRatings.clear();
  for (const r of S.me.ratings || []) if (r.id && r.r) S.myRatings.set(r.id, { r: r.r, date: r.date || '2000-01-01', src: 'fw', fav: r.fav });
  for (const [id, r] of Object.entries(S.local.ratings)) {
    const cur = S.myRatings.get(id);
    if (!cur || (r.date || '') >= (cur.date || '')) S.myRatings.set(id, { r: r.r, date: r.date, src: 'app' });
  }
  S.want = new Set([...(S.me.want || []).filter(w => w.id).map(w => w.id), ...Object.keys(S.local.want).filter(k => S.local.want[k])]);
  for (const k of Object.keys(S.local.want)) if (S.local.want[k] === false) S.want.delete(k);
}

/* ================================================================== MODEL
   Ocena przewidywana = regresja grzbietowa na:
     • jakości tytułu (IMDb, Filmweb, TMDB, RT, Metacritic – znormalizowane),
     • Twoich „gustach" w grupach cech (gatunki, słowa kluczowe, reżyserzy, scenarzyści,
       aktorzy, kraje, język, dekada) – liczonych jako wygładzona średnia Twoich odchyleń,
     • podobieństwie do tytułów, które już oceniłeś (kNN).
   Wszystkie cechy dla tytułów treningowych liczone są metodą leave-one-out,
   więc wagi uczą się na uczciwych przewidywaniach, a nie na zapamiętaniu odpowiedzi.  */

const GROUPS = ['g', 'k', 'd', 'w', 'a', 'c', 'l', 'y', 't'];
const LAMBDA = { g: 6, k: 4, d: 1.5, w: 1.5, a: 2.5, c: 5, l: 6, y: 8, t: 10 };
const SIMW = { g: 1, k: 1.2, d: 4, w: 3, a: 1.2, c: .5, l: .5, y: .5, t: .3 };

function feats(t) {
  if (t._f) return t._f;
  const f = [];
  for (const g of t.g || []) f.push('g' + g);
  for (const k of t.k || []) f.push('k' + k);
  for (const d of t.d || []) f.push('d' + d);
  for (const w of (t.w || []).slice(0, 3)) f.push('w' + w);
  for (const a of (t.a || []).slice(0, 5)) f.push('a' + a);
  for (const c of (t.c || []).slice(0, 2)) f.push('c' + c);
  if (t.lang) f.push('l' + t.lang);
  if (t.y) f.push('y' + Math.floor(t.y / 10) * 10);
  f.push('t' + t.id[0]);
  t._f = f;
  let n = 0; for (const x of f) n += SIMW[x[0]] || 1;
  t._fn = n;
  return f;
}

let NORM;
function computeNorms() {
  const acc = { ir: [], fr: [], tr: [], rt: [], mc: [], lv: [] };
  for (const t of S.cat) {
    if (t.ir) acc.ir.push(t.ir); if (t.fr) acc.fr.push(t.fr); if (t.tv > 30) acc.tr.push(t.tr);
    if (t.rt != null) acc.rt.push(t.rt); if (t.mc != null) acc.mc.push(t.mc);
    acc.lv.push(Math.log10(1 + (t.iv || t.tv || 0)));
  }
  const st = a => { const m = a.reduce((s, x) => s + x, 0) / Math.max(1, a.length); const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length); return [m, Math.sqrt(v) || 1]; };
  NORM = Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, st(a)]));
}
function zq(t, k, val) { const v = val ?? t[k]; return v == null ? null : (v - NORM[k][0]) / NORM[k][1]; }

function dense(t) {
  if (t._d) return t._d;
  const zi = zq(t, 'ir'), zf = zq(t, 'fr'), zt = t.tv > 30 ? zq(t, 'tr') : null, zr = zq(t, 'rt'), zm = zq(t, 'mc');
  const avail = [zi, zf, zt].filter(x => x != null);
  const q = avail.length ? avail.reduce((a, b) => a + b, 0) / avail.length : 0;
  const crit = [zr, zm].filter(x => x != null);
  const qc = crit.length ? crit.reduce((a, b) => a + b, 0) / crit.length : q;
  const yr = t.y ? (t.y - 2005) / 15 : 0;
  t._d = [
    zi ?? q, zf ?? q, qc,
    zq(t, 'lv', Math.log10(1 + (t.iv || t.tv || 0))),
    yr, t.id[0] === 't' ? 1 : 0, t.len ? Math.min(3, t.len / 60) - 1.8 : 0,
    (t.aw || []).length ? 1 : 0,
  ];
  return t._d;
}
const DENSE_N = 8;

/** Trenuje model na liście [{t, r}]; zwraca obiekt z predict(t, excludeIdx). */
function train(samples) {
  const n = samples.length;
  const mu = samples.reduce((s, x) => s + x.r, 0) / Math.max(1, n);
  // Krok 1: liniowa baza na cechach gęstych
  const X1 = samples.map(s => [1, ...dense(s.t)]);
  const w1 = ridge(X1, samples.map(s => s.r), 3);
  const base = X1.map(x => dot(x, w1));
  const e = samples.map((s, i) => s.r - base[i]);
  // Krok 2: sumy odchyleń dla każdej cechy + indeks odwrotny do kNN
  const sum = new Map(), cnt = new Map(), post = new Map();
  samples.forEach((s, i) => {
    for (const f of feats(s.t)) {
      sum.set(f, (sum.get(f) || 0) + e[i]); cnt.set(f, (cnt.get(f) || 0) + 1);
      let p = post.get(f); if (!p) post.set(f, p = []); p.push(i);
    }
  });
  const groupScores = (t, self) => {
    const gs = Object.fromEntries(GROUPS.map(g => [g, [0, 0]]));
    const contrib = [];
    for (const f of feats(t)) {
      let s = sum.get(f) || 0, c = cnt.get(f) || 0;
      if (self != null && c && post.get(f).includes(self)) { s -= e[self]; c -= 1; }
      if (!c) continue;
      const g = f[0], a = s / (c + LAMBDA[g]);
      gs[g][0] += a; gs[g][1] += 1;
      contrib.push([f, a, c]);
    }
    // kNN – ważone podobieństwo Jaccarda
    const ov = new Map();
    for (const f of feats(t)) {
      const p = post.get(f); if (!p) continue;
      const w = SIMW[f[0]] || 1;
      for (const i of p) if (i !== self) ov.set(i, (ov.get(i) || 0) + w);
    }
    const sims = [];
    for (const [i, o] of ov) { const sim = o / (t._fn + samples[i].t._fn - o); if (sim > .08) sims.push([sim, i]); }
    sims.sort((a, b) => b[0] - a[0]);
    let ns = 0, ds = 0;
    for (const [sim, i] of sims.slice(0, 25)) { ns += sim * sim * e[i]; ds += sim * sim; }
    const knn = ns / (ds + .15);
    const v = GROUPS.map(g => gs[g][1] ? gs[g][0] / Math.sqrt(gs[g][1]) : 0);
    return { v: [...v, knn], contrib, sims: sims.slice(0, 5) };
  };
  // Krok 3: końcowa regresja na [gęste + grupy + kNN] z cechami LOO
  const X2 = samples.map((s, i) => [1, ...dense(s.t), ...groupScores(s.t, i).v]);
  const w2 = ridge(X2, samples.map(s => s.r), 4);
  const predict = (t, self) => {
    const gsr = groupScores(t, self);
    const x = [1, ...dense(t), ...gsr.v];
    let p = dot(x, w2);
    p = Math.max(1, Math.min(10, p));
    return { p, gsr };
  };
  return { mu, w2, predict, samples, e };
}

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * (b[i] || 0); return s; }
function ridge(X, y, lam) {
  const d = X[0]?.length || 1, A = Array.from({ length: d }, () => new Float64Array(d)), b = new Float64Array(d);
  for (let r = 0; r < X.length; r++) {
    const x = X[r];
    for (let i = 0; i < d; i++) { b[i] += x[i] * y[r]; for (let j = 0; j < d; j++) A[i][j] += x[i] * x[j]; }
  }
  for (let i = 1; i < d; i++) A[i][i] += lam; // bez kary dla wyrazu wolnego
  A[0][0] += 1e-6;
  // eliminacja Gaussa
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < d; c++) {
    let piv = c; for (let r = c + 1; r < d; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const v = M[c][c] || 1e-9;
    for (let r = 0; r < d; r++) if (r !== c) { const k = M[r][c] / v; for (let j = c; j <= d; j++) M[r][j] -= k * M[c][j]; }
  }
  return M.map((row, i) => row[d] / (row[i] || 1e-9));
}

function trainingSamples(beforeDate) {
  const out = [];
  for (const [id, r] of S.myRatings) {
    const t = S.byId.get(id);
    if (t && (!beforeDate || (r.date || '') < beforeDate)) out.push({ t, r: r.r, date: r.date, id });
  }
  return out;
}

function buildModel() {
  computeNorms();
  const samples = trainingSamples();
  S.preds.clear(); S.reasons.clear();
  if (samples.length < 15) { S.model = null; return; }
  const m = train(samples);
  S.model = m;
  const idx = new Map(samples.map((s, i) => [s.id, i]));
  for (const t of S.cat) {
    const self = idx.get(t.id);
    const { p, gsr } = m.predict(t, self);
    S.preds.set(t.id, p);
    S.reasons.set(t.id, gsr);
  }
  logPredictions();
  S.evalCache = null;
}

/* Dziennik przewidywań – żeby sprawdzić model na tym, co obejrzysz w przyszłości. */
function logPredictions() {
  const log = S.local.predlog, d = today();
  for (const [id, p] of S.preds) if (!S.myRatings.has(id) && !log[id]) log[id] = [Math.round(p * 10) / 10, d];
  saveLocal();
}

/* Ocena trafności:
   1) walidacja krzyżowa (5 części),
   2) test w czasie: model uczony na starszych ocenach przewiduje 20% najnowszych,
   3) test na żywo: przewidywania zapisane, zanim oceniłeś tytuł.            */
function evaluate() {
  if (S.evalCache) return S.evalCache;
  const all = trainingSamples();
  if (all.length < 30) return null;
  const res = {};
  // 1. CV
  const shuffled = all.map((s, i) => [((i * 2654435761) >>> 0) % 1000, s]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const K = 5, cvPairs = [];
  for (let k = 0; k < K; k++) {
    const test = shuffled.filter((_, i) => i % K === k), trn = shuffled.filter((_, i) => i % K !== k);
    const m = train(trn);
    for (const s of test) cvPairs.push([m.predict(s.t).p, s.r, s]);
  }
  res.cv = metrics(cvPairs);
  // naiwne odniesienia: średnia Twoich ocen i sama ocena Filmwebu/IMDb
  const mu = all.reduce((a, s) => a + s.r, 0) / all.length;
  res.baseMean = metrics(all.map(s => [mu, s.r]));
  const crowd = all.filter(s => s.t.fr || s.t.ir).map(s => [s.t.fr || s.t.ir, s.r]);
  // dopasuj przesunięcie tłumu do Twojej średniej (uczciwe porównanie)
  const off = crowd.reduce((a, [p, r]) => a + (r - p), 0) / Math.max(1, crowd.length);
  res.baseCrowd = metrics(crowd.map(([p, r]) => [p + off, r]));
  // 2. test w czasie
  const dated = all.filter(s => s.date && s.date > '2001').sort((a, b) => a.date.localeCompare(b.date));
  if (dated.length >= 40) {
    const cut = Math.floor(dated.length * .8);
    const m = train(dated.slice(0, cut));
    const pairs = dated.slice(cut).map(s => [m.predict(s.t).p, s.r, s]);
    res.time = metrics(pairs); res.timeFrom = dated[cut].date; res.timePairs = pairs;
  }
  // 3. na żywo
  const live = [];
  for (const [id, [p, d]] of Object.entries(S.local.predlog)) {
    const r = S.myRatings.get(id);
    if (r && r.date && r.date >= d) live.push([p, r.r, { t: S.byId.get(id), r: r.r, date: r.date }]);
  }
  res.live = live.length ? metrics(live) : null; res.livePairs = live;
  res.cvPairs = cvPairs; res.n = all.length;
  S.evalCache = res;
  return res;
}
function metrics(pairs) {
  const n = pairs.length; if (!n) return null;
  const mae = pairs.reduce((a, [p, r]) => a + Math.abs(p - r), 0) / n;
  const within1 = pairs.filter(([p, r]) => Math.abs(p - r) <= 1).length / n;
  const top = pairs.filter(([p]) => p >= 7.5), hit = top.filter(([, r]) => r >= 7).length;
  const ps = pairs.map(x => x[0]), rs = pairs.map(x => x[1]);
  return { n, mae, within1, topN: top.length, hit: top.length ? hit / top.length : null, corr: pearson(ps, rs) };
}
function pearson(a, b) {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return sa && sb ? sab / Math.sqrt(sa * sb) : 0;
}

/* Uzasadnienie rekomendacji po polsku */
function explain(t, max = 3) {
  const g = S.reasons.get(t.id); if (!g || !S.model) return [];
  const out = [];
  const label = f => {
    const k = f[0], v = f.slice(1);
    if (k === 'g') return 'gatunek ' + genreName(v).toLowerCase();
    if (k === 'k') return 'motyw „' + ((S.meta.keywords || {})[v] || v) + '"';
    if (k === 'd') return 'reżyser ' + v;
    if (k === 'w') return 'scenarzysta ' + v;
    if (k === 'a') return v;
    if (k === 'c') return 'kino: ' + (COUNTRY[v] || v);
    if (k === 'y') return 'lata ' + v.slice(2) + '.';
    return null;
  };
  if (g.sims.length) {
    const names = g.sims.filter(([s]) => s > .15).slice(0, 2).map(([, i]) => {
      const s = S.model.samples[i]; return `${s.t.t} (${s.r})`;
    });
    if (names.length) out.push('Podobny do: ' + names.join(', '));
  }
  const pos = g.contrib.filter(([f, a, c]) => a > .12 && c >= 2 && !'tl'.includes(f[0]))
    .sort((a, b) => b[1] * Math.sqrt(b[2]) - a[1] * Math.sqrt(a[2])).slice(0, 3).map(([f]) => label(f)).filter(Boolean);
  if (pos.length) out.push('Lubisz: ' + pos.join(', '));
  const neg = g.contrib.filter(([f, a, c]) => a < -.35 && c >= 3 && 'gdkw'.includes(f[0])).sort((a, b) => a[1] - b[1]).slice(0, 1).map(([f]) => label(f));
  if (neg.length) out.push('Uwaga: zwykle słabiej oceniasz – ' + neg[0]);
  return out.slice(0, max);
}

/* ================================================================== FILTRY */
function passes(t, f, ignoreSeen) {
  if (f.type === 'movie' && t.id[0] !== 'm') return false;
  if (f.type === 'tv' && t.id[0] !== 't') return false;
  if (f.genres.length && !f.genres.every(g => (t.g || []).includes(+g))) return false;
  if (t.y && (t.y < f.yFrom || t.y > f.yTo)) return false;
  if (!t.y && (f.yFrom > 1920 || f.yTo < 2030)) return false;
  if (f.rtMax && t.len && t.len > f.rtMax) return false;
  const pv = t.pv || {};
  const provSel = f.onlySubs ? S.local.subs : f.provs;
  if (provSel.length && !provSel.some(p => pv[p] && 'sfa'.includes(pv[p]))) return false;
  if (f.awards.length) {
    const pool = f.awardMode === 'win' ? (t.aw || []) : [...(t.aw || []), ...(t.an || [])];
    if (!f.awards.some(a => pool.includes(a))) return false;
  }
  if (f.minFw && !(t.fr >= f.minFw)) return false;
  if (f.minImdb && !(t.ir >= f.minImdb)) return false;
  if (f.minRt && !(t.rt >= f.minRt)) return false;
  if (f.minMc && !(t.mc >= f.minMc)) return false;
  if (f.minVotes && (t.iv || t.tv || 0) < f.minVotes) return false;
  if (f.country === 'PL' && !(t.c || []).includes('PL')) return false;
  if (f.country === 'notUS' && (t.c || [])[0] === 'US') return false;
  if (!ignoreSeen && f.hideSeen && (S.myRatings.has(t.id) || S.local.hidden[t.id])) return false;
  return true;
}
function activeFilterCount() {
  const f = S.f, d = DEFAULT_F(); let n = 0;
  for (const k of Object.keys(d)) {
    if (k === 'sort' || k === 'awardMode') continue;
    if (JSON.stringify(f[k]) !== JSON.stringify(d[k])) n++;
  }
  return n;
}
function sortFn(sort) {
  const P = t => S.preds.get(t.id) ?? 0;
  return {
    match: (a, b) => (P(b) + (b.pop > 30 ? .02 : 0)) - (P(a) + (a.pop > 30 ? .02 : 0)),
    fw: (a, b) => (b.fr || 0) - (a.fr || 0),
    imdb: (a, b) => (b.ir || 0) - (a.ir || 0),
    rt: (a, b) => (b.rt ?? -1) - (a.rt ?? -1),
    mc: (a, b) => (b.mc ?? -1) - (a.mc ?? -1),
    new: (a, b) => (b.y || 0) - (a.y || 0),
    pop: (a, b) => (b.pop || 0) - (a.pop || 0),
    votes: (a, b) => (b.iv || b.tv || 0) - (a.iv || a.tv || 0),
  }[sort] || ((a, b) => P(b) - P(a));
}

function search(q) {
  q = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return S.cat.filter(t => norm(t.t).includes(q) || norm(t.ot).includes(q) ||
    (t.d || []).some(x => norm(x).includes(q)) || (t.a || []).some(x => norm(x).includes(q)));
}

/* ================================================================== WIDOKI */
function render() {
  const titles = { rec: 'Dla Ciebie', browse: 'Katalog', mine: 'Moje', stats: 'Trafność' };
  $('#title').textContent = titles[S.tab];
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('#searchBar').hidden = S.tab !== 'browse';
  $('#filterBtn').hidden = !(S.tab === 'rec' || S.tab === 'browse');
  const n = activeFilterCount(); $('#filterCount').hidden = !n; $('#filterCount').textContent = n;
  renderChips();
  ({ rec: viewRec, browse: viewBrowse, mine: viewMine, stats: viewStats })[S.tab]();
}

function renderChips() {
  const el = $('#chips');
  if (S.tab === 'mine' || S.tab === 'stats') { el.innerHTML = ''; return; }
  const f = S.f;
  const chips = [
    ['type:all', 'Wszystko', f.type === 'all'], ['type:movie', 'Filmy', f.type === 'movie'], ['type:tv', 'Seriale', f.type === 'tv'],
  ];
  if (S.local.subs.length) chips.push(['subs', 'Moje serwisy', f.onlySubs]);
  chips.push(['aw:oscar', 'Oscary', f.awards.includes('oscar')], ['pl', 'Polskie', f.country === 'PL'],
    ['new', 'Ostatnie 3 lata', f.yFrom >= new Date().getFullYear() - 3]);
  el.innerHTML = chips.map(([k, l, on]) => `<button class="chip${on ? ' on' : ''}" data-chip="${k}">${l}</button>`).join('');
}

function card(t, mode) {
  const p = S.preds.get(t.id), mine = S.myRatings.get(t.id);
  const poster = t.p ? `style="background-image:url('${IMG}w185${t.p}')"` : '';
  const genres = (t.g || []).slice(0, 2).map(genreName).join(', ');
  const meta = [t.id[0] === 't' ? 'Serial' : null, t.y, genres, t.len ? t.len + ' min' : null].filter(Boolean).join(' · ');
  const sc = [];
  if (t.fr) sc.push(`<span class="sc fw">FW <b>${fmt(t.fr)}</b></span>`);
  if (t.ir) sc.push(`<span class="sc">IMDb <b>${fmt(t.ir)}</b></span>`);
  if (t.rt != null) sc.push(`<span class="sc">RT <b>${t.rt}%</b></span>`);
  if (t.mc != null) sc.push(`<span class="sc">MC <b>${t.mc}</b></span>`);
  if (!t.ir && !t.fr && t.tv > 30) sc.push(`<span class="sc">TMDB <b>${fmt(t.tr)}</b></span>`);
  const aw = (t.aw || []).length ? `<span class="aw">🏆 ${t.aw.slice(0, 3).map(a => AWARDS[a]).join(', ')}</span>` : '';
  const provs = Object.entries(t.pv || {}).filter(([, c]) => 'sfa'.includes(c)).sort((a, b) => (provInfo(a[0])?.[2] ?? 99) - (provInfo(b[0])?.[2] ?? 99)).slice(0, 5)
    .map(([id]) => { const pi = provInfo(id); return pi?.[1] ? `<img src="${IMG}w45${pi[1]}" alt="${esc(pi[0])}" title="${esc(pi[0])}" loading="lazy">` : ''; }).join('');
  const why = mode === 'rec' ? explain(t, 1)[0] : '';
  const right = mine ? `<div class="mine"><b>${mine.r}</b><span>Ty</span></div>`
    : p != null ? `<div class="pred"><b>${fmt(p)}</b><span>dla Ciebie</span></div>` : '';
  return `<div class="card" data-id="${t.id}">
    <div class="poster" ${poster}>${t.p ? '' : `<div class="ph">${esc(t.t)}</div>`}</div>
    <div class="info"><div class="ttl">${esc(t.t)}</div><div class="sub">${esc(meta)}</div>
      ${why ? `<div class="why">${esc(why)}</div>` : aw}
      <div class="scores">${sc.join('')}</div>${provs ? `<div class="provs">${provs}</div>` : ''}</div>${right}</div>`;
}

function list(items, mode) {
  const shown = items.slice(0, S.limit);
  return shown.map(t => card(t, mode)).join('') +
    (items.length > S.limit ? `<button class="more" data-more>Pokaż więcej (${items.length - S.limit})</button>` : '');
}

function viewRec() {
  const v = $('#view');
  if (!S.model) {
    v.innerHTML = `<div class="empty">Potrzebuję co najmniej 15 Twoich ocen dopasowanych do katalogu, żeby nauczyć się Twojego gustu.<br><br>Teraz mam: ${trainingSamples().length}.</div>`;
    return;
  }
  const items = S.cat.filter(t => passes(t, S.f) && !S.myRatings.has(t.id) && !S.local.hidden[t.id]).sort(sortFn(S.f.sort === 'match' ? 'match' : S.f.sort));
  const want = items.filter(t => S.want.has(t.id)).slice(0, 8);
  const ev = evaluate();
  let html = ev ? `<div class="note">Model zna ${ev.n} Twoich ocen · w teście myli się średnio o <b>${fmt(ev.cv.mae, 2)}</b> pkt</div>` : '';
  if (want.length && S.f.sort === 'match') {
    html += `<div class="section-h">Z Twojej listy „Chcę zobaczyć"</div>` + want.slice(0, 4).map(t => card(t, 'rec')).join('');
    html += `<div class="section-h">Najlepiej dopasowane</div>`;
  }
  v.innerHTML = html + (items.length ? list(items, 'rec') : `<div class="empty">Nic nie pasuje do filtrów.</div>`);
}

function viewBrowse() {
  const base = S.q.length >= 2 ? search(S.q) : S.cat;
  const items = base.filter(t => passes(t, S.f, S.q.length >= 2)).sort(sortFn(S.f.sort));
  $('#view').innerHTML = `<div class="note">${items.length.toLocaleString('pl')} tytułów</div>` + (items.length ? list(items, 'browse') : `<div class="empty">Brak wyników.</div>`);
}

function viewMine() {
  const sub = S.mineTab || 'rated';
  let items, html = `<div class="chips" style="padding:0 0 10px">${[['rated', 'Ocenione'], ['want', 'Chcę zobaczyć'], ['hidden', 'Ukryte'], ['unmatched', 'Niedopasowane']]
    .map(([k, l]) => `<button class="chip${sub === k ? ' on' : ''}" data-mine="${k}">${l}</button>`).join('')}</div>`;
  if (sub === 'rated') {
    items = [...S.myRatings.entries()].filter(([id]) => S.byId.has(id)).sort((a, b) => (b[1].date || '').localeCompare(a[1].date || '')).map(([id]) => S.byId.get(id));
    const avg = items.length ? [...S.myRatings.values()].reduce((a, r) => a + r.r, 0) / S.myRatings.size : 0;
    html += `<div class="note">${S.myRatings.size} ocen · średnia ${fmt(avg)} · źródło: Filmweb (${esc(S.me.user)})${Object.keys(S.local.ratings).length ? ' + oceny z aplikacji' : ''}</div>`;
  } else if (sub === 'want') {
    items = [...S.want].map(id => S.byId.get(id)).filter(Boolean).sort((a, b) => (S.preds.get(b.id) || 0) - (S.preds.get(a.id) || 0));
    html += `<div class="note">Posortowane według dopasowania do Ciebie</div>`;
  } else if (sub === 'hidden') {
    items = Object.keys(S.local.hidden).filter(k => S.local.hidden[k]).map(id => S.byId.get(id)).filter(Boolean);
  } else {
    const um = [...(S.me.ratings || []), ...(S.me.want || [])].filter(r => !r.id || !S.byId.has(r.id));
    $('#view').innerHTML = html + `<div class="note">Tytuły z Filmwebu, których nie udało się znaleźć w TMDB (${um.length}). Nie biorą udziału w nauce.</div>` +
      `<table class="mini">${um.map(r => `<tr><td>${esc(r.t || 'Filmweb #' + r.fw)}</td><td>${r.y || ''}</td><td>${r.r || ''}</td></tr>`).join('')}</table>`;
    return;
  }
  $('#view').innerHTML = html + (items.length ? list(items, 'mine') : `<div class="empty">Pusto.</div>`);
}

function viewStats() {
  const v = $('#view'), ev = evaluate();
  if (!ev) { v.innerHTML = `<div class="empty">Za mało ocen do oceny trafności (potrzeba 30).</div>`; return; }
  const pct = x => x == null ? '–' : Math.round(x * 100) + '%';
  const gain = 1 - ev.cv.mae / ev.baseCrowd.mae;
  let html = `<div class="section-h">Jak dobrze model Cię zna</div>
  <div class="stat-grid">
    <div class="stat"><b>±${fmt(ev.cv.mae, 2)}</b><span>średni błąd przewidywania (skala 1–10)</span></div>
    <div class="stat"><b>${pct(ev.cv.within1)}</b><span>przewidywań trafionych z dokładnością do 1 pkt</span></div>
    <div class="stat"><b>${pct(ev.cv.hit)}</b><span>tytułów z prognozą ≥ 7,5, które oceniłeś na 7+</span></div>
    <div class="stat"><b>${fmt(ev.cv.corr, 2)}</b><span>korelacja prognoz z Twoimi ocenami</span></div>
  </div>
  <div class="note">Walidacja krzyżowa: model ocenia każdy tytuł, nie widząc Twojej oceny tego tytułu.</div>
  <div class="section-h">W porównaniu z prostszymi metodami</div>
  <table class="mini">
    <tr><td>Kinoteka (Twój model)</td><td><b>±${fmt(ev.cv.mae, 2)}</b></td></tr>
    <tr><td>Ocena Filmwebu/IMDb (dopasowana do Twojej średniej)</td><td>±${fmt(ev.baseCrowd.mae, 2)}</td></tr>
    <tr><td>Zawsze Twoja średnia</td><td>±${fmt(ev.baseMean.mae, 2)}</td></tr>
  </table>
  <div class="note">${gain > 0 ? `Model przewiduje Twoje oceny o <b class="good">${Math.round(gain * 100)}% dokładniej</b> niż sama ocena portali.` : `Na razie model nie bije ocen portali – potrzebuje więcej Twoich ocen.`}</div>`;
  if (ev.time) {
    html += `<div class="section-h">Test w czasie</div>
    <div class="note">Model uczony tylko na ocenach sprzed ${ev.timeFrom} przewidział ${ev.time.n} najnowszych: średni błąd <b>±${fmt(ev.time.mae, 2)}</b>, ${pct(ev.time.within1)} w granicy 1 pkt.</div>
    <table class="mini">${ev.timePairs.slice(-12).reverse().map(([p, r, s]) => `<tr><td>${esc(s.t.t)}</td><td>prognoza ${fmt(p)}</td><td class="${Math.abs(p - r) <= 1 ? 'good' : 'bad'}">Ty ${r}</td></tr>`).join('')}</table>`;
  }
  html += `<div class="section-h">Na żywo</div>`;
  html += ev.live ? `<div class="note">Przewidywania zapisane, zanim oceniłeś tytuł (${ev.live.n}): średni błąd <b>±${fmt(ev.live.mae, 2)}</b>.</div>
    <table class="mini">${ev.livePairs.slice(-15).reverse().map(([p, r, s]) => `<tr><td>${esc(s.t?.t)}</td><td>prognoza ${fmt(p)}</td><td class="${Math.abs(p - r) <= 1 ? 'good' : 'bad'}">Ty ${r}</td></tr>`).join('')}</table>`
    : `<div class="note">Aplikacja zapisała prognozy dla ${Object.keys(S.local.predlog).length.toLocaleString('pl')} tytułów. Gdy obejrzysz coś i ocenisz (na Filmwebie albo tutaj), pojawi się tu porównanie prognozy z Twoją oceną.</div>`;
  // co model wie o guście
  const m = S.model, sum = new Map(), cnt = new Map();
  m.samples.forEach((s, i) => { for (const f of feats(s.t)) if ('gdk'.includes(f[0])) { sum.set(f, (sum.get(f) || 0) + m.e[i]); cnt.set(f, (cnt.get(f) || 0) + 1); } });
  const aff = [...sum].map(([f, s]) => [f, s / (cnt.get(f) + LAMBDA[f[0]]), cnt.get(f)]).filter(x => x[2] >= 3);
  const lbl = f => f[0] === 'g' ? genreName(f.slice(1)) : f[0] === 'd' ? f.slice(1) + ' (reż.)' : '„' + ((S.meta.keywords || {})[f.slice(1)] || f.slice(1)) + '"';
  const top = aff.sort((a, b) => b[1] - a[1]).slice(0, 8), bot = aff.slice(-6).reverse();
  html += `<div class="section-h">Czego model nauczył się o Tobie</div>
    <div class="note">Oceniasz wyżej, niż wynikałoby z ocen portali:</div><table class="mini">${top.map(([f, a, c]) => `<tr><td>${esc(lbl(f))}</td><td>${c} tyt.</td><td class="good">+${fmt(a, 2)}</td></tr>`).join('')}</table>
    <div class="note" style="margin-top:12px">Oceniasz niżej:</div><table class="mini">${bot.map(([f, a, c]) => `<tr><td>${esc(lbl(f))}</td><td>${c} tyt.</td><td class="bad">${fmt(a, 2)}</td></tr>`).join('')}</table>`;
  html += settingsHTML();
  v.innerHTML = html;
}

function settingsHTML() {
  const provs = Object.entries(S.meta.providers || {}).filter(([id]) => S.cat.some(t => t.pv && 'sfa'.includes(t.pv[id] || 'x')))
    .sort((a, b) => a[1][2] - b[1][2]).slice(0, 30);
  return `<div class="section-h">Moje serwisy</div><div class="note">Zaznacz, co masz – filtr „Moje serwisy" pokaże tylko to, co obejrzysz bez dopłat.</div>
  <div class="f-chips">${provs.map(([id, p]) => `<button class="chip${S.local.subs.includes(id) ? ' on' : ''}" data-sub="${id}">${p[1] ? `<img src="${IMG}w45${p[1]}" style="width:16px;height:16px;border-radius:4px;vertical-align:-3px;margin-right:5px">` : ''}${esc(p[0])}</button>`).join('')}</div>
  <div class="foot">Dane z ${esc(S.meta.updated || '–')} · ${S.cat.length.toLocaleString('pl')} tytułów<br>
  Oceny: Filmweb, IMDb, Rotten Tomatoes, Metacritic · Katalog i plakaty: <a href="https://www.themoviedb.org" target="_blank" rel="noopener">TMDB</a> · Dostępność VOD: JustWatch · Nagrody: Wikidata.<br>
  Ten produkt korzysta z API TMDB, ale nie jest przez TMDB wspierany ani certyfikowany.</div>`;
}

/* ------------------------------------------------------------------ szczegóły */
async function openDetail(id) {
  const t = S.byId.get(id); if (!t) return;
  const p = S.preds.get(id), mine = S.myRatings.get(id);
  const reasons = mine ? [] : explain(t, 4);
  const pv = Object.entries(t.pv || {}).sort((a, b) => 'sfarb'.indexOf(a[1]) - 'sfarb'.indexOf(b[1]));
  const kind = { s: 'abonament', f: 'za darmo', a: 'z reklamami', r: 'wypożyczenie', b: 'kupno' };
  const tmdbUrl = `https://www.themoviedb.org/${t.id[0] === 'm' ? 'movie' : 'tv'}/${t.id.slice(1)}`;
  const awards = [...(t.aw || []).map(a => `🏆 ${AWARDS[a]}`), ...(t.an || []).map(a => `nominacja: ${AWARDS[a]}`)];
  const body = $('#sheet .sheet-body');
  body.innerHTML = `<div class="grab"></div><button class="x" data-close aria-label="Zamknij">✕</button>
  <div class="d-head"><div class="poster big" ${t.p ? `style="background-image:url('${IMG}w342${t.p}')"` : ''}></div>
    <div><h2>${esc(t.t)}</h2>${t.ot ? `<div class="d-ot">${esc(t.ot)}</div>` : ''}
    <div class="d-meta">${[t.id[0] === 't' ? 'Serial' + (t.seasons ? `, ${t.seasons} sez.` : '') : 'Film', t.y, t.len ? t.len + ' min' : null].filter(Boolean).join(' · ')}<br>
    ${(t.g || []).map(genreName).join(', ')}<br>${(t.c || []).map(c => COUNTRY[c] || c).join(', ')}</div></div></div>
  <div class="d-scores">
    ${mine ? `<div class="d-sc me"><span>Twoja ocena</span><b>${mine.r}</b></div>` : p != null ? `<div class="d-sc me"><span>Dla Ciebie</span><b>${fmt(p)}</b></div>` : ''}
    ${t.fr ? `<div class="d-sc"><span>Filmweb</span><b>${fmt(t.fr)}</b><small>${kfmt(t.fn || 0)}</small></div>` : ''}
    ${t.ir ? `<div class="d-sc"><span>IMDb</span><b>${fmt(t.ir)}</b><small>${kfmt(t.iv || 0)}</small></div>` : ''}
    ${t.rt != null ? `<div class="d-sc"><span>Rotten T.</span><b>${t.rt}%</b></div>` : ''}
    ${t.mc != null ? `<div class="d-sc"><span>Metacritic</span><b>${t.mc}</b></div>` : ''}
    ${t.tv ? `<div class="d-sc"><span>TMDB</span><b>${fmt(t.tr)}</b><small>${kfmt(t.tv)}</small></div>` : ''}
  </div>
  ${reasons.length ? `<div class="d-sec"><h3>Dlaczego dla Ciebie</h3><ul class="reasons">${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
  <div class="d-sec"><h3>Opis</h3><p id="ov">…</p></div>
  ${t.d?.length ? `<div class="d-sec"><h3>${t.id[0] === 't' ? 'Twórcy' : 'Reżyseria'}</h3><p>${esc(t.d.join(', '))}</p></div>` : ''}
  ${t.a?.length ? `<div class="d-sec"><h3>Obsada</h3><p>${esc(t.a.join(', '))}</p></div>` : ''}
  ${awards.length || t.awt ? `<div class="d-sec"><h3>Nagrody</h3><p>${esc(awards.join(' · '))}${t.awl?.length ? `<br><small style="color:var(--tx2)">${esc(t.awl.join(' · '))}</small>` : ''}${t.awt ? `<br><small style="color:var(--tx2)">${esc(t.awt)}</small>` : ''}</p></div>` : ''}
  <div class="d-sec"><h3>Gdzie obejrzeć w Polsce</h3>${pv.length ? `<div class="prov-row">${pv.map(([pid, c]) => { const pi = provInfo(pid) || [pid]; return `<a class="prov" href="${tmdbUrl}/watch?locale=PL" target="_blank" rel="noopener">${pi[1] ? `<img src="${IMG}w92${pi[1]}">` : ''}<span>${esc(pi[0])}<br><em>${kind[c]}</em></span></a>`; }).join('')}</div>` : '<p style="color:var(--tx2)">Brak w serwisach VOD w Polsce.</p>'}</div>
  <div class="d-sec"><h3>${mine ? 'Zmień ocenę' : 'Obejrzałem – moja ocena'}</h3>
    <div class="stars">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<button data-rate="${n}" class="${mine?.r === n ? 'on' : ''}">${n}</button>`).join('')}</div>
    <div class="note" style="margin:6px 0 0">Ocena trafia do modelu od razu. Na Filmweb wystaw ją osobno – aplikacja nie może zapisywać na Twoim koncie.</div></div>
  <div class="btn-row">
    <button class="btn${S.want.has(id) ? ' on' : ''}" data-want>${S.want.has(id) ? '✓ Chcę zobaczyć' : '+ Chcę zobaczyć'}</button>
    <button class="btn" data-hide>${S.local.hidden[id] ? 'Przywróć' : 'Nie dla mnie'}</button>
  </div>
  <div class="d-sec links">
    <a href="${t.fw ? `https://www.filmweb.pl/${t.id[0] === 't' ? 'serial' : 'film'}/x-${t.y || 0}-${t.fw}` : `https://www.filmweb.pl/search#/?query=${encodeURIComponent(t.ot || t.t)}`}" target="_blank" rel="noopener">Filmweb</a>
    ${t.imdb ? `<a href="https://www.imdb.com/title/${t.imdb}/" target="_blank" rel="noopener">IMDb</a>` : ''}
    <a href="${tmdbUrl}" target="_blank" rel="noopener">TMDB</a>
    <a href="https://www.youtube.com/results?search_query=${encodeURIComponent((t.ot || t.t) + ' ' + (t.y || '') + ' zwiastun')}" target="_blank" rel="noopener">Zwiastun</a>
  </div>`;
  body.dataset.id = id;
  $('#sheet').hidden = false;
  body.scrollTop = 0;
  try {
    const ov = await getJSON(`data/ov/${+t.id.slice(1) % 32}.json`);
    $('#ov').textContent = ov[t.id] || 'Brak opisu.';
  } catch (e) { $('#ov').textContent = 'Brak opisu.'; }
}
function closeSheet() { $('#sheet').hidden = true; }

/* ------------------------------------------------------------------ panel filtrów */
function openFilters() {
  const f = S.f, years = new Date().getFullYear();
  const genres = Object.entries(S.meta.genres || {}).sort((a, b) => a[1].localeCompare(b[1], 'pl'));
  const provs = Object.entries(S.meta.providers || {}).filter(([id]) => S.cat.some(t => t.pv && 'sfa'.includes(t.pv[id] || 'x'))).sort((a, b) => a[1][2] - b[1][2]).slice(0, 24);
  const rng = (key, min, max, step, label, unit = '') =>
    `<div class="f-group"><h3>${label}</h3><div class="range"><input type="range" data-f="${key}" min="${min}" max="${max}" step="${step}" value="${f[key]}"><output>${f[key] ? (unit === '%' ? f[key] + '%' : fmt(f[key], step < 1 ? 1 : 0)) : 'dowolnie'}</output></div></div>`;
  const body = $('#sheet .sheet-body');
  body.dataset.id = '';
  body.innerHTML = `<div class="grab"></div><button class="x" data-close aria-label="Zamknij">✕</button><h2 style="margin:0 0 6px;font-family:Georgia,serif">Filtry</h2>
  <div class="f-group"><h3>Sortuj</h3><div class="row2"><select data-f="sort">
    ${[['match', 'Dopasowanie do mnie'], ['fw', 'Ocena Filmweb'], ['imdb', 'Ocena IMDb'], ['rt', 'Rotten Tomatoes'], ['mc', 'Metacritic'], ['new', 'Najnowsze'], ['pop', 'Popularne teraz'], ['votes', 'Liczba głosów']]
      .map(([v, l]) => `<option value="${v}"${f.sort === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div></div>
  <div class="f-group"><h3>Rodzaj</h3><div class="f-chips">${[['all', 'Wszystko'], ['movie', 'Filmy'], ['tv', 'Seriale']].map(([v, l]) => `<button class="chip${f.type === v ? ' on' : ''}" data-set="type:${v}">${l}</button>`).join('')}</div></div>
  <div class="f-group"><h3>Gdzie obejrzeć (abonament / za darmo)</h3><div class="f-chips">
    ${S.local.subs.length ? `<button class="chip${f.onlySubs ? ' on' : ''}" data-toggle="onlySubs">★ Moje serwisy</button>` : ''}
    ${provs.map(([id, p]) => `<button class="chip${f.provs.includes(id) ? ' on' : ''}" data-arr="provs:${id}">${p[1] ? `<img src="${IMG}w45${p[1]}">` : ''}${esc(p[0])}</button>`).join('')}</div></div>
  <div class="f-group"><h3>Nagrody</h3><div class="f-chips" style="margin-bottom:8px">
    <button class="chip${f.awardMode === 'win' ? ' on' : ''}" data-set="awardMode:win">wygrane</button><button class="chip${f.awardMode === 'nom' ? ' on' : ''}" data-set="awardMode:nom">także nominacje</button></div>
    <div class="f-chips">${Object.entries(AWARDS).map(([k, l]) => `<button class="chip${f.awards.includes(k) ? ' on' : ''}" data-arr="awards:${k}">${l}</button>`).join('')}</div></div>
  <div class="f-group"><h3>Lata produkcji</h3><div class="row2">
    <select data-f="yFrom">${yearOpts(f.yFrom, years, true)}</select><select data-f="yTo">${yearOpts(f.yTo, years, false)}</select></div></div>
  <div class="f-group"><h3>Gatunki (wszystkie zaznaczone)</h3><div class="f-chips">${genres.map(([id, n]) => `<button class="chip${f.genres.includes(id) ? ' on' : ''}" data-arr="genres:${id}">${esc(n)}</button>`).join('')}</div></div>
  ${rng('minFw', 0, 9, .1, 'Min. ocena Filmweb')}${rng('minImdb', 0, 9, .1, 'Min. ocena IMDb')}
  ${rng('minRt', 0, 100, 5, 'Min. Rotten Tomatoes', '%')}${rng('minMc', 0, 100, 5, 'Min. Metacritic')}
  ${rng('rtMax', 0, 240, 10, 'Maks. długość (min)')}
  <div class="f-group"><h3>Kraj</h3><div class="f-chips">${[['', 'Dowolny'], ['PL', 'Tylko polskie'], ['notUS', 'Bez amerykańskich']].map(([v, l]) => `<button class="chip${f.country === v ? ' on' : ''}" data-set="country:${v}">${l}</button>`).join('')}</div></div>
  <div class="f-group"><h3>Popularność</h3><div class="f-chips">${[[0, 'Dowolna'], [10000, '10 tys.+ głosów'], [100000, '100 tys.+'], [500000, 'Hity 500 tys.+']].map(([v, l]) => `<button class="chip${f.minVotes === v ? ' on' : ''}" data-set="minVotes:${v}">${l}</button>`).join('')}</div></div>
  <div class="f-group"><div class="f-chips"><button class="chip${f.hideSeen ? ' on' : ''}" data-toggle="hideSeen">Ukryj obejrzane i odrzucone</button></div></div>
  <div class="sticky-actions"><button class="btn" data-reset>Wyczyść</button><button class="btn gold" data-close>Pokaż</button></div>`;
  $('#sheet').hidden = false;
}
function yearOpts(sel, now, from) {
  const ys = [1920, 1950, 1960, 1970, 1980, 1990, 2000, 2005, 2010, 2015, 2018, 2020, 2021, 2022, 2023, 2024, 2025, now - 1, now, 2030];
  return [...new Set(ys)].sort((a, b) => a - b).map(y => `<option value="${y}"${y === sel ? ' selected' : ''}>${from ? (y === 1920 ? 'od początku' : 'od ' + y) : (y === 2030 ? 'do dziś' : 'do ' + y)}</option>`).join('');
}

/* ------------------------------------------------------------------ zdarzenia */
function setRating(id, r) {
  S.local.ratings[id] = { r, date: today() };
  delete S.local.hidden[id];
  saveLocal(); mergeRatings(); buildModel();
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-id],[data-tab],[data-chip],[data-more],[data-mine],[data-sub],[data-rate],[data-want],[data-hide],[data-set],[data-arr],[data-toggle],[data-reset],[data-close],.sheet-bg,#filterBtn');
  if (!el) return;
  if (el.classList.contains('sheet-bg') || el.dataset.close != null) { closeSheet(); render(); return; }
  if (el.id === 'filterBtn') { openFilters(); return; }
  if (el.dataset.tab) { S.tab = el.dataset.tab; S.limit = 40; window.scrollTo(0, 0); render(); return; }
  if (el.dataset.more != null) { S.limit += 60; render(); return; }
  if (el.dataset.mine) { S.mineTab = el.dataset.mine; S.limit = 40; render(); return; }
  if (el.dataset.sub) { const s = S.local.subs, i = s.indexOf(el.dataset.sub); i >= 0 ? s.splice(i, 1) : s.push(el.dataset.sub); saveLocal(); render(); return; }
  if (el.dataset.chip) {
    const [k, v] = el.dataset.chip.split(':'), f = S.f;
    if (k === 'type') f.type = v;
    if (k === 'subs') f.onlySubs = !f.onlySubs;
    if (k === 'aw') { const i = f.awards.indexOf(v); i >= 0 ? f.awards.splice(i, 1) : f.awards.push(v); }
    if (k === 'pl') f.country = f.country === 'PL' ? '' : 'PL';
    if (k === 'new') { const y = new Date().getFullYear() - 3; f.yFrom = f.yFrom >= y ? 1920 : y; }
    S.limit = 40; saveLocal(); render(); return;
  }
  const sid = $('#sheet .sheet-body').dataset.id;
  if (el.dataset.rate) { setRating(sid, +el.dataset.rate); openDetail(sid); return; }
  if (el.dataset.want != null) { S.local.want[sid] = !S.want.has(sid); saveLocal(); mergeRatings(); openDetail(sid); return; }
  if (el.dataset.hide != null) { if (S.local.hidden[sid]) delete S.local.hidden[sid]; else S.local.hidden[sid] = 1; saveLocal(); closeSheet(); render(); return; }
  if (el.dataset.set) { const [k, v] = el.dataset.set.split(':'); S.f[k] = k === 'minVotes' ? +v : v; saveLocal(); openFilters(); return; }
  if (el.dataset.arr) { const [k, v] = el.dataset.arr.split(':'), a = S.f[k], i = a.indexOf(v); i >= 0 ? a.splice(i, 1) : a.push(v); saveLocal(); openFilters(); return; }
  if (el.dataset.toggle) { S.f[el.dataset.toggle] = !S.f[el.dataset.toggle]; saveLocal(); openFilters(); return; }
  if (el.dataset.reset != null) { S.f = DEFAULT_F(); saveLocal(); openFilters(); return; }
  if (el.dataset.id && el.classList.contains('card')) openDetail(el.dataset.id);
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'q') { S.q = el.value.trim(); S.limit = 40; clearTimeout(S._qt); S._qt = setTimeout(render, 180); return; }
  if (el.dataset.f) {
    S.f[el.dataset.f] = el.tagName === 'SELECT' && el.dataset.f === 'sort' ? el.value : +el.value;
    const out = el.parentElement.querySelector('output');
    if (out) out.textContent = +el.value ? (el.dataset.f === 'minRt' ? el.value + '%' : fmt(+el.value, el.step < 1 ? 1 : 0)) : 'dowolnie';
    saveLocal();
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
load();
