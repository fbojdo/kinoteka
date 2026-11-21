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
  local: { ratings: {}, want: {}, hidden: {}, subs: [], predlog: {}, filters: null, decl: {}, tune: null },
  myRatings: new Map(),   // id -> {r, date, src}
  model: null, preds: new Map(), reasons: new Map(),
  tab: 'rec', q: '', limit: 40,
  f: null,
};
const DEFAULT_F = () => ({
  type: 'all', genres: [], regions: [], yFrom: 1920, yTo: 2030, rtMax: 0, provs: [], onlySubs: false, awards: [], awardMode: 'win',
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
  if (!S.cat.length) {
    let st = {}; try { st = await getJSON('data/status.json'); } catch (e) { /* brak */ }
    $('#view').innerHTML = `<div class="empty">Katalog jest jeszcze pusty.<br><small>${esc((st.notes || []).join(' ') || 'Aktualizacja danych trwa albo się nie powiodła.')}</small><br><br><small>Oceny z Filmwebu: ${st.filmweb?.ratings ?? '–'} · TMDB: ${st.tmdb_ok ? 'OK' : 'błąd'}</small></div>`;
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
   Przewidywana ocena = regresja grzbietowa (z wagami) na:
     • jakości tytułu wg portali (IMDb, Filmweb, TMDB, krytycy RT/Metacritic),
     • gust podobnych widzów (MovieLens – pole cf z automatu),
     • Twoim guście w grupach cech: gatunki, tematy, motywy, reżyserzy, scenarzyści,
       aktorzy, kraje, regiony, język, dekada – OSOBNO dla filmów i seriali
       (z „pożyczaniem" gustu z drugiego typu, gdy danych mało),
     • podobieństwie do tytułów, które oceniłeś (kNN).
   Dane uczące: Twoje oceny (świeższe ważą więcej) + słabe sygnały z „Chcę zobaczyć",
   „Nie dla mnie" i Twoich deklaracji. Cechy liczone metodą leave-one-out,
   a siła wygładzania dobierana automatycznie walidacją krzyżową.            */

const GROUPS = ['g', 'h', 'k', 'd', 'w', 'a', 'c', 'r', 'l', 'y'];
const BASE_LAMBDA = { g: 6, h: 5, k: 4, d: 1.5, w: 1.5, a: 2.5, c: 5, r: 5, l: 6, y: 8 };
const SIMW = { g: 1, h: 1.5, k: 1, d: 4, w: 3, a: 1.2, c: .4, r: .6, l: .5, y: .5, t: .3 };
const TYPE_POOL = 4;   // ile „wirtualnych ocen" pożycza gust drugiego typu (film↔serial)
let LAMBDA = { ...BASE_LAMBDA };
let RIDGE = 4;

const REGION = { PL: 'pl', GB: 'uk', IE: 'uk', US: 'us', CA: 'ang', AU: 'ang', NZ: 'ang',
  JP: 'asia', KR: 'asia', CN: 'asia', HK: 'asia', TW: 'asia', IN: 'asia', TH: 'asia', ID: 'asia', PH: 'asia', VN: 'asia',
  MX: 'latam', AR: 'latam', BR: 'latam', CL: 'latam', CO: 'latam', PE: 'latam', UY: 'latam', CU: 'latam',
  IR: 'me', IL: 'me', TR: 'me', LB: 'me', EG: 'me', SA: 'me', AE: 'me', JO: 'me', PS: 'me',
  RU: 'east', UA: 'east', BY: 'east', GE: 'east', KZ: 'east', AM: 'east', AZ: 'east' };
const EU = 'FR DE IT ES PT NL BE LU AT CH DK SE NO FI IS CZ SK HU RO BG GR HR SI RS BA ME MK AL LT LV EE MT CY'.split(' ');
EU.forEach(c => REGION[c] = 'eu');
const REGION_NAMES = { pl: 'kino polskie', eu: 'kino europejskie', uk: 'kino brytyjskie/irlandzkie', us: 'kino amerykańskie',
  ang: 'Kanada/Australia', asia: 'kino azjatyckie', latam: 'Ameryka Łacińska', me: 'Bliski Wschód', east: 'Europa Wschodnia', other: 'inne kraje' };

const THEMES = [
  ['war', 'wojna', /\b(war|world war|soldier|military|battle|nazi|holocaust|army|resistance|occupation)\b/i],
  ['history', 'historia', /(histor|period piece|\d{2}th century|medieval|ancient|royal|king|queen|empire|biograph)/i],
  ['politics', 'polityka i władza', /(politic|president|election|government|corruption|dictator|spy|espionage|\bcia\b|kgb|cold war|totalitarian|communis|propaganda)/i],
  ['crime', 'kryminał i śledztwo', /(crime|murder|detective|police|gangster|mafia|heist|serial killer|investigat|drug|cartel|robbery|thief)/i],
  ['law', 'prawo i sąd', /(lawyer|court|trial|justice|prison|attorney|judge)/i],
  ['family', 'rodzina', /(family|father|mother|daughter|\bson\b|marriage|divorce|parent|sibling|brother|sister|grandparent)/i],
  ['love', 'miłość i związki', /(love|romance|relationship|affair|wedding|couple|dating)/i],
  ['youth', 'dorastanie', /(coming of age|teenager|high school|youth|adolescen|childhood|boarding school)/i],
  ['money', 'biznes i pieniądze', /(business|corporat|wall street|money|banker|financ|capitalis|startup|wealth|real estate|company|ceo|stock market)/i],
  ['society', 'problemy społeczne', /(poverty|social|working class|immigra|refugee|racism|inequality|class differences|discrimination|feminis)/i],
  ['psyche', 'psychologia', /(psycholog|mental|depress|obsess|identity|trauma|grief|loneliness|addiction|alcoholism|guilt|midlife)/i],
  ['scifi', 'science fiction', /(space|alien|future|dystop|time travel|robot|artificial intelligence|virtual reality|cyberpunk|post-apocalyptic)/i],
  ['fantasy', 'fantastyka', /(magic|fantasy|dragon|wizard|myth|supernatural|fairy tale|witch)/i],
  ['horror', 'groza', /(horror|ghost|zombie|vampire|demon|haunted|slasher|possession|exorcism)/i],
  ['art', 'sztuka i muzyka', /(music|musician|artist|painter|writer|novelist|filmmaking|theat|dance|singer|band|jazz|photograph)/i],
  ['sport', 'sport', /(sport|football|soccer|boxing|baseball|basketball|racing|olympic|tennis|chess)/i],
  ['faith', 'wiara i religia', /(religio|church|priest|faith|\bgod\b|catholic|\bnun\b|bible|monastery)/i],
  ['adventure', 'przygoda i przetrwanie', /(survival|wilderness|adventure|journey|road trip|expedition|mountain|ocean|island|desert)/i],
  ['satire', 'satyra i czarny humor', /(satire|parody|dark comedy|black comedy|absurd|farce)/i],
  ['book', 'adaptacje literatury', /(based on novel|based on book|literary adaptation|based on play|based on short story)/i],
  ['truth', 'prawdziwe historie', /(based on true story|true crime|based on real|real events)/i],
  ['medicine', 'medycyna', /(doctor|hospital|disease|medical|nurse|cancer|epidemic|pandemic|surgeon)/i],
  ['media', 'media i technologia', /(journalis|media|internet|social media|television|hacker|reporter|newspaper)/i],
  ['smalltown', 'prowincja', /(small town|village|rural|countryside|farm)/i],
];
const THEME_NAMES = Object.fromEntries(THEMES.map(([k, n]) => [k, n]));
const KW_THEMES = new Map();
function kwThemes(kid) {
  if (KW_THEMES.has(kid)) return KW_THEMES.get(kid);
  const name = (S.meta.keywords || {})[kid] || '';
  const out = name ? THEMES.filter(([, , rx]) => rx.test(name)).map(x => x[0]) : [];
  KW_THEMES.set(kid, out);
  return out;
}

function regionOf(t) {
  const c = (t.c || [])[0];
  return c ? (REGION[c] || 'other') : null;
}

/* cechy tytułu (bez typu); typ film/serial obsługiwany osobno */
function feats(t) {
  if (t._f) return t._f;
  const f = new Set();
  for (const g of t.g || []) f.add('g' + g);
  for (const k of t.k || []) { f.add('k' + k); for (const h of kwThemes(String(k))) f.add('h' + h); }
  for (const d of t.d || []) f.add('d' + d);
  for (const w of (t.w || []).slice(0, 3)) f.add('w' + w);
  for (const a of (t.a || []).slice(0, 5)) f.add('a' + a);
  for (const c of (t.c || []).slice(0, 2)) { f.add('c' + c); f.add('r' + (REGION[c] || 'other')); }
  if (t.lang) f.add('l' + t.lang);
  if (t.y) f.add('y' + Math.floor(t.y / 10) * 10);
  t._f = [...f];
  let n = 0; for (const x of t._f) n += SIMW[x[0]] || 1;
  t._fn = n + SIMW.t;
  return t._f;
}
const typ = t => t.id[0];   // 'm' | 't'

let NORM;
function computeNorms() {
  const acc = { ir: [], fr: [], tr: [], rt: [], mc: [], lv: [], cf: [] };
  for (const t of S.cat) {
    if (t.ir) acc.ir.push(t.ir); if (t.fr) acc.fr.push(t.fr); if (t.tv > 30) acc.tr.push(t.tr);
    if (t.rt != null) acc.rt.push(t.rt); if (t.mc != null) acc.mc.push(t.mc);
    if (t.cf != null) acc.cf.push(t.cf);
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
  const cfw = t.cfs ? Math.min(1, t.cfs / 3) : 0;   // pewność sygnału MovieLens
  t._d = [
    zi ?? q, zf ?? q, qc - q,
    zq(t, 'lv', Math.log10(1 + (t.iv || t.tv || 0))),
    yr, typ(t) === 't' ? 1 : 0, t.len ? Math.min(3, t.len / 60) - 1.8 : 0,
    (t.aw || []).length ? 1 : 0,
    t.cf != null ? t.cf * cfw : 0, t.cf != null ? cfw : 0,
  ];
  return t._d;
}

/* Deklaracje użytkownika -> pseudo-obserwacje na cechach */
function declPriors() {
  const out = new Map();   // klucz cechy (z prefiksem typu lub bez) -> [suma, liczba]
  const d = S.local.decl || {};
  for (const [key, v] of Object.entries(d)) {   // key: "m|rEU" / "t|hpolitics" / "*|g18"
    if (!v) continue;
    out.set(key, [v * 0.8 * 3, 3]);
  }
  return out;
}

/** Trenuje model na [{t, r, w}] ; zwraca obiekt z predict(t, selfIdx). */
function train(samples, opt = {}) {
  const lam = opt.lambda || LAMBDA, ridgeL = opt.ridge || RIDGE;
  const n = samples.length;
  const W = samples.map(s => s.w ?? 1);
  // Krok 1: liniowa baza na cechach gęstych
  const X1 = samples.map(s => [1, ...dense(s.t)]);
  const w1 = ridge(X1, samples.map(s => s.r), 3, W);
  const e = samples.map((s, i) => s.r - dot(X1[i], w1));
  // Krok 2: statystyki odchyleń – wspólne i osobne dla filmów/seriali
  const sum = new Map(), cnt = new Map(), post = new Map();
  const add = (k, v, c) => { sum.set(k, (sum.get(k) || 0) + v); cnt.set(k, (cnt.get(k) || 0) + c); };
  samples.forEach((s, i) => {
    const ty = typ(s.t);
    for (const f of feats(s.t)) {
      add(f, e[i] * W[i], W[i]); add(ty + '|' + f, e[i] * W[i], W[i]);
      if (s.real !== false) { let p = post.get(f); if (!p) post.set(f, p = []); p.push(i); }
    }
  });
  for (const [k, [sv, c]] of declPriors()) {
    if (k.startsWith('*|')) { add(k.slice(2), sv, c); add('m|' + k.slice(2), sv, c); add('t|' + k.slice(2), sv, c); }
    else { add(k, sv, c); add(k.slice(2), sv * .5, c * .5); }
  }
  const groupScores = (t, self) => {
    const ty = typ(t);
    const gs = Object.fromEntries(GROUPS.map(g => [g, [0, 0]]));
    const contrib = [];
    const sw = self != null ? W[self] : 0, se = self != null ? e[self] * sw : 0;
    for (const f of feats(t)) {
      let s = sum.get(f) || 0, c = cnt.get(f) || 0;
      let st = sum.get(ty + '|' + f) || 0, ct = cnt.get(ty + '|' + f) || 0;
      if (self != null && c && post.get(f)?.includes(self)) { s -= se; c -= sw; st -= se; ct -= sw; }
      if (c <= 0.01) continue;
      const g = f[0], L = lam[g];
      const shared = s / (c + L);
      const a = (st + TYPE_POOL * shared) / (ct + TYPE_POOL + L * .5);   // gust dla tego typu, ściągany do wspólnego
      gs[g][0] += a; gs[g][1] += 1;
      contrib.push([f, a, ct, c]);
    }
    // kNN – ważone podobieństwo Jaccarda (+ premia za ten sam typ)
    const ov = new Map();
    for (const f of feats(t)) {
      const p = post.get(f); if (!p) continue;
      const w = SIMW[f[0]] || 1;
      for (const i of p) if (i !== self) ov.set(i, (ov.get(i) || 0) + w);
    }
    const sims = [];
    for (const [i, o] of ov) {
      const same = typ(samples[i].t) === ty ? SIMW.t : 0;
      const sim = (o + same) / (t._fn + samples[i].t._fn - o - same);
      if (sim > .08) sims.push([sim, i]);
    }
    sims.sort((a, b) => b[0] - a[0]);
    let ns = 0, ds = 0, ev = 0;
    for (const [sim, i] of sims.slice(0, 25)) { const w = sim * sim * W[i]; ns += w * e[i]; ds += w; ev += sim; }
    const knn = ns / (ds + .15);
    const v = GROUPS.map(g => gs[g][1] ? gs[g][0] / Math.sqrt(gs[g][1]) : 0);
    return { v: [...v, knn], contrib, sims: sims.slice(0, 5), evidence: ev };
  };
  // Krok 3: końcowa regresja na [gęste + grupy + kNN] z cechami LOO
  const X2 = samples.map((s, i) => [1, ...dense(s.t), ...groupScores(s.t, i).v]);
  const w2 = ridge(X2, samples.map(s => s.r), ridgeL, W);
  const resid = samples.map((s, i) => s.r - dot(X2[i], w2)).filter((_, i) => samples[i].real !== false);
  const sigma = Math.sqrt(resid.reduce((a, x) => a + x * x, 0) / Math.max(1, resid.length));
  const predict = (t, self) => {
    const gsr = groupScores(t, self);
    const p = Math.max(1, Math.min(10, dot([1, ...dense(t), ...gsr.v], w2)));
    // niepewność: mniej dowodów (podobnych ocenionych, znanych cech) => szerzej
    const unc = sigma * (0.6 + 0.8 / Math.sqrt(1 + gsr.evidence + gsr.contrib.length / 6));
    return { p, gsr, unc };
  };
  return { w2, predict, samples, e, sigma };
}

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * (b[i] || 0); return s; }
function ridge(X, y, lam, W) {
  const d = X[0]?.length || 1, A = Array.from({ length: d }, () => new Float64Array(d)), b = new Float64Array(d);
  for (let r = 0; r < X.length; r++) {
    const x = X[r], w = W ? W[r] : 1;
    for (let i = 0; i < d; i++) { b[i] += w * x[i] * y[r]; for (let j = 0; j < d; j++) A[i][j] += w * x[i] * x[j]; }
  }
  for (let i = 1; i < d; i++) A[i][i] += lam;
  A[0][0] += 1e-6;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < d; c++) {
    let piv = c; for (let r = c + 1; r < d; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const v = M[c][c] || 1e-9;
    for (let r = 0; r < d; r++) if (r !== c) { const k = M[r][c] / v; for (let j = c; j <= d; j++) M[r][j] -= k * M[c][j]; }
  }
  return M.map((row, i) => row[d] / (row[i] || 1e-9));
}

/* Waga świeżości: ocena sprzed 4 lat liczy się ~60% w porównaniu z dzisiejszą */
function recencyW(date) {
  if (!date || date < '2001') return .7;
  const years = (Date.now() - Date.parse(date)) / 3.15e10;
  return .45 + .55 * Math.exp(-Math.max(0, years) / 4);
}

/** Prawdziwe oceny (opcjonalnie tylko sprzed daty) */
function trainingSamples(beforeDate) {
  const out = [];
  for (const [id, r] of S.myRatings) {
    const t = S.byId.get(id);
    if (t && (!beforeDate || (r.date || '') < beforeDate)) out.push({ t, r: r.r, date: r.date, id, w: recencyW(r.date) });
  }
  return out;
}
/** Słabe sygnały: „Chcę zobaczyć" (+) i „Nie dla mnie" (−) */
function weakSamples(mu) {
  const out = [];
  for (const id of S.want || []) { const t = S.byId.get(id); if (t && !S.myRatings.has(id)) out.push({ t, r: mu + .9, w: .25, id, real: false }); }
  for (const id of Object.keys(S.local.hidden || {})) { const t = S.byId.get(id); if (t && S.local.hidden[id] && !S.myRatings.has(id)) out.push({ t, r: mu - 2.2, w: .45, id, real: false }); }
  return out;
}

/* Autostrojenie: wybiera siłę wygładzania gustu i regularyzację pod Twoje dane (3-krotna CV) */
function autotune(real) {
  const key = Math.floor(real.length / 10) + ':' + Math.floor(Object.keys(S.local.hidden || {}).length / 10) + ':' + Object.keys(S.local.decl || {}).length;
  const cached = S.local.tune;
  if (cached && cached.key === key) return cached;
  if (real.length < 40) return { key, scale: 1, ridge: 4 };
  let best = null;
  for (const scale of [.5, 1, 2]) for (const rl of [2, 5, 10]) {
    const lam = Object.fromEntries(Object.entries(BASE_LAMBDA).map(([k, v]) => [k, v * scale]));
    let err = 0, n = 0;
    for (let k = 0; k < 3; k++) {
      const test = real.filter((_, i) => i % 3 === k), trn = real.filter((_, i) => i % 3 !== k);
      const m = train(trn, { lambda: lam, ridge: rl });
      for (const s of test) { err += Math.abs(m.predict(s.t).p - s.r); n++; }
    }
    const mae = err / n;
    if (!best || mae < best.mae) best = { key, scale, ridge: rl, mae };
  }
  S.local.tune = best; saveLocal();
  return best;
}

function buildModel() {
  computeNorms();
  const real = trainingSamples();
  S.preds.clear(); S.reasons.clear(); S.unc = new Map();
  if (real.length < 15) { S.model = null; return; }
  const mu = real.reduce((a, s) => a + s.r, 0) / real.length;
  const tune = autotune(real);
  LAMBDA = Object.fromEntries(Object.entries(BASE_LAMBDA).map(([k, v]) => [k, v * tune.scale]));
  RIDGE = tune.ridge;
  S.tune = tune;
  const samples = [...real, ...weakSamples(mu)];
  const m = train(samples);
  S.model = m; S.mu = mu;
  const idx = new Map(samples.map((s, i) => [s.id, i]));
  for (const t of S.cat) {
    const { p, gsr, unc } = m.predict(t, idx.get(t.id));
    S.preds.set(t.id, p); S.reasons.set(t.id, gsr); S.unc.set(t.id, unc);
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

/* Ocena trafności: walidacja krzyżowa, test w czasie, test na żywo. */
function evaluate() {
  if (S.evalCache) return S.evalCache;
  const all = trainingSamples();
  if (all.length < 30) return null;
  const mu = all.reduce((a, s) => a + s.r, 0) / all.length, weak = weakSamples(mu);
  const res = {};
  const shuffled = all.map((s, i) => [((i * 2654435761) >>> 0) % 1000, s]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const K = 5, cvPairs = [];
  for (let k = 0; k < K; k++) {
    const test = shuffled.filter((_, i) => i % K === k), trn = shuffled.filter((_, i) => i % K !== k);
    const m = train([...trn, ...weak]);
    for (const s of test) cvPairs.push([m.predict(s.t).p, s.r, s]);
  }
  res.cv = metrics(cvPairs);
  res.cvMovie = metrics(cvPairs.filter(x => typ(x[2].t) === 'm'));
  res.cvTv = metrics(cvPairs.filter(x => typ(x[2].t) === 't'));
  res.baseMean = metrics(all.map(s => [mu, s.r]));
  const crowd = all.filter(s => s.t.fr || s.t.ir).map(s => [s.t.fr || s.t.ir, s.r]);
  const off = crowd.reduce((a, [p, r]) => a + (r - p), 0) / Math.max(1, crowd.length);
  res.baseCrowd = metrics(crowd.map(([p, r]) => [p + off, r]));
  const dated = all.filter(s => s.date && s.date > '2001').sort((a, b) => a.date.localeCompare(b.date));
  if (dated.length >= 40) {
    const cut = Math.floor(dated.length * .8);
    const m = train([...dated.slice(0, cut), ...weak]);
    const pairs = dated.slice(cut).map(s => [m.predict(s.t).p, s.r, s]);
    res.time = metrics(pairs); res.timeFrom = dated[cut].date; res.timePairs = pairs;
  }
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

function featLabel(f) {
  const k = f[0], v = f.slice(1);
  if (k === 'g') return 'gatunek ' + genreName(v).toLowerCase();
  if (k === 'h') return 'temat: ' + (THEME_NAMES[v] || v);
  if (k === 'k') return 'motyw „' + ((S.meta.keywords || {})[v] || v) + '"';
  if (k === 'd') return 'reżyser ' + v;
  if (k === 'w') return 'scenarzysta ' + v;
  if (k === 'a') return v;
  if (k === 'c') return 'kraj: ' + (COUNTRY[v] || v);
  if (k === 'r') return REGION_NAMES[v] || v;
  if (k === 'l') return 'język: ' + v;
  if (k === 'y') return 'lata ' + v.slice(2) + '.';
  return null;
}

/* Uzasadnienie rekomendacji po polsku */
function explain(t, max = 3) {
  const g = S.reasons.get(t.id); if (!g || !S.model) return [];
  const out = [];
  if (t.cf != null && t.cfs > 1 && t.cf > .35) out.push('Widzowie o guście podobnym do Twojego oceniają go wysoko');
  if (g.sims.length) {
    const names = g.sims.filter(([s]) => s > .15).slice(0, 2).map(([, i]) => {
      const s = S.model.samples[i]; return `${s.t.t} (${s.r})`;
    });
    if (names.length) out.push('Podobny do: ' + names.join(', '));
  }
  const kind = typ(t) === 't' ? 'w serialach' : 'w filmach';
  const pos = g.contrib.filter(([f, a, ct, c]) => a > .12 && c >= 2 && !'lyk'.includes(f[0]))
    .sort((a, b) => b[1] * Math.sqrt(b[3]) - a[1] * Math.sqrt(a[3])).slice(0, 3).map(([f]) => featLabel(f)).filter(Boolean);
  if (pos.length) out.push(`Lubisz ${kind}: ` + pos.join(', '));
  const neg = g.contrib.filter(([f, a, ct, c]) => a < -.35 && c >= 3 && 'gdhrw'.includes(f[0])).sort((a, b) => a[1] - b[1]).slice(0, 1).map(([f]) => featLabel(f));
  if (neg.length) out.push('Uwaga: zwykle słabiej oceniasz – ' + neg[0]);
  return out.slice(0, max);
}

/* Ranking z uwzględnieniem pewności i różnorodności (MMR) */
function rankRecs(items) {
  const score = t => (S.preds.get(t.id) ?? 0) - .35 * ((S.unc && S.unc.get(t.id)) || 0) + (t.pop > 30 ? .02 : 0);
  const sorted = items.map(t => [score(t), t]).sort((a, b) => b[0] - a[0]);
  const head = sorted.slice(0, 160), rest = sorted.slice(160).map(x => x[1]);
  const chosen = [], used = new Map();
  while (head.length) {
    let bi = 0, bv = -1e9;
    for (let i = 0; i < head.length; i++) {
      const t = head[i][1];
      let pen = 0;
      for (const f of feats(t)) if ('dh'.includes(f[0]) || f[0] === 'g') pen += (used.get(f) || 0) * (f[0] === 'd' ? .25 : .03);
      const v = head[i][0] - Math.min(.8, pen);
      if (v > bv) { bv = v; bi = i; }
    }
    const [, t] = head.splice(bi, 1)[0];
    chosen.push(t);
    for (const f of feats(t)) used.set(f, (used.get(f) || 0) + 1);
  }
  return [...chosen, ...rest];
}

/* ================================================================== PROFIL WIDZA
   Portret gustu z Twoich ocen: wymiary (osie), archetyp, tematy, twórcy, kanon,
   miejsca, gdzie różnisz się od tłumu. To opis gustu filmowego – nie test psychologiczny. */
const LIGHT_G = new Set([35, 10751, 16, 10402, 10749, 12]);      // komedia, familijny, animacja, muzyczny, romans, przygoda
const HEAVY_G = new Set([18, 10752, 36, 99, 80, 53, 9648, 10768]);  // dramat, wojenny, historyczny, dokument, kryminał, thriller…
function entropy(counts) {
  const tot = counts.reduce((a, b) => a + b, 0); if (!tot) return 0;
  return -counts.reduce((a, c) => c ? a + (c / tot) * Math.log(c / tot) : a, 0) / Math.log(Math.max(2, counts.length));
}
function profileData() {
  const R = [...S.myRatings.entries()].map(([id, r]) => ({ t: S.byId.get(id), r: r.r, date: r.date })).filter(x => x.t);
  if (R.length < 20) return null;
  const mean = a => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  const mu = mean(R.map(x => x.r));
  const sd = Math.sqrt(mean(R.map(x => (x.r - mu) ** 2)));
  const crowdPairs = R.filter(x => x.t.fr || x.t.ir);
  const generosity = mean(crowdPairs.map(x => x.r - (x.t.fr || x.t.ir)));
  const corr = (k, sel) => { const p = R.filter(x => sel(x.t) != null); return p.length > 15 ? pearson(p.map(x => sel(x.t)), p.map(x => x.r)) : null; };
  const cAud = corr('aud', t => t.fr || t.ir), cCrit = corr('crit', t => t.mc != null ? t.mc / 10 : (t.rt != null ? t.rt / 10 : null));
  const votes = R.map(x => Math.log10(1 + (x.t.iv || x.t.tv * 20 || 1)));
  const mainstream = mean(votes);                              // ~3 nisza … ~6 hit
  const years = R.filter(x => x.t.y).map(x => x.t.y);
  const medYear = years.sort((a, b) => a - b)[Math.floor(years.length / 2)];
  const reg = {}; R.forEach(x => { const g = regionOf(x.t) || 'other'; reg[g] = (reg[g] || 0) + 1; });
  const nonUS = 1 - (reg.us || 0) / R.length;
  let light = 0, heavy = 0; R.forEach(x => { (x.t.g || []).forEach(g => { if (LIGHT_G.has(g)) light++; if (HEAVY_G.has(g)) heavy++; }); });
  const gravity = heavy / Math.max(1, light + heavy);
  const gc = {}; R.forEach(x => (x.t.g || []).forEach(g => gc[g] = (gc[g] || 0) + 1));
  const dc = {}; R.forEach(x => (x.t.d || []).forEach(d => dc[d] = (dc[d] || 0) + 1));
  const variety = (entropy(Object.values(gc)) + Math.min(1, Object.keys(dc).length / R.length)) / 2;
  const tvShare = R.filter(x => typ(x.t) === 't').length / R.length;
  const lens = R.filter(x => x.t.len && typ(x.t) === 'm').map(x => x.t.len);
  // tematy / regiony / twórcy z odchyleniem od tłumu
  const aff = (pref, ty, minN) => {
    const s = {}, c = {};
    R.forEach(x => { if (ty && typ(x.t) !== ty) return; const base = x.t.fr || x.t.ir || mu; for (const f of feats(x.t)) if (f[0] === pref) { s[f] = (s[f] || 0) + (x.r - base - generosity); c[f] = (c[f] || 0) + 1; } });
    return Object.keys(s).filter(f => c[f] >= minN).map(f => ({ f, a: s[f] / (c[f] + 3), n: c[f] })).sort((a, b) => b.a - a.a);
  };
  const themeCount = {}; R.forEach(x => new Set(feats(x.t).filter(f => f[0] === 'h')).forEach(f => themeCount[f] = (themeCount[f] || 0) + 1));
  const dirs = Object.entries(dc).filter(([, n]) => n >= 2).map(([d, n]) => ({ d, n, avg: mean(R.filter(x => (x.t.d || []).includes(d)).map(x => x.r)) })).sort((a, b) => b.avg * Math.sqrt(b.n) - a.avg * Math.sqrt(a.n));
  const canon = R.slice().sort((a, b) => b.r - a.r || (b.t.fr || 0) - (a.t.fr || 0)).slice(0, 10);
  const against = crowdPairs.map(x => ({ ...x, d: x.r - (x.t.fr || x.t.ir) - generosity })).sort((a, b) => b.d - a.d);
  // dryf gustu: porównanie ostatnich 2 lat z wcześniejszymi
  const recent = R.filter(x => x.date && x.date >= new Date(Date.now() - 2 * 3.15e10).toISOString().slice(0, 10));
  const older = R.filter(x => x.date && !recent.includes(x));
  const shift = (sel) => recent.length >= 15 && older.length >= 15 ? mean(recent.map(x => sel(x.t))) - mean(older.map(x => sel(x.t))) : null;
  return {
    R, mu, sd, generosity, cAud, cCrit, mainstream, medYear, reg, nonUS, gravity, variety, tvShare, lens,
    themesM: aff('h', 'm', 3), themesT: aff('h', 't', 2), regions: aff('r', null, 3), themeCount, dirs, canon,
    above: against.slice(0, 6), below: against.slice(-6).reverse(),
    driftEU: shift(t => regionOf(t) === 'us' ? 0 : 1), driftHeavy: shift(t => (t.g || []).some(g => HEAVY_G.has(g)) ? 1 : 0), driftTV: shift(t => typ(t) === 't' ? 1 : 0),
  };
}
function archetype(P) {
  const tags = [];
  if (P.nonUS > .5 && P.gravity > .6) tags.push(['Koneser kina autorskiego', 'Szukasz filmów spoza głównego nurtu Hollywood, z ciężarem i przemyśleniem.']);
  else if (P.nonUS > .5) tags.push(['Kosmopolita', 'Chętnie wychodzisz poza kino amerykańskie – ciekawią Cię inne kultury i style opowiadania.']);
  if (P.gravity > .7) tags.push(['Poszukiwacz sensu', 'Wybierasz historie, które poruszają poważne tematy – rozrywka sama w sobie to dla Ciebie za mało.']);
  else if (P.gravity < .4) tags.push(['Hedonista ekranu', 'Kino to dla Ciebie przyjemność i odpoczynek – liczy się lekkość i dobra zabawa.']);
  if (P.mainstream < 4.3) tags.push(['Odkrywca', 'Sięgasz po tytuły mało znane – nie potrzebujesz, by coś było głośne, żeby dać temu szansę.']);
  else if (P.mainstream > 5.3) tags.push(['Uczestnik rozmowy', 'Oglądasz to, o czym się mówi – kino jest dla Ciebie też tematem do rozmów z innymi.']);
  if (P.tvShare > .35) tags.push(['Maratończyk', 'Lubisz długie formy i rozbudowane postaci – seriale to ważna część Twojego oglądania.']);
  if (P.variety > .75) tags.push(['Eklektyk', 'Twój gust jest szeroki – skaczesz między gatunkami i twórcami.']);
  else if (P.variety < .5) tags.push(['Wierny swoim', 'Masz wyraźne ulubione rejony i do nich wracasz.']);
  if (P.medYear && P.medYear < 2000) tags.push(['Strażnik klasyki', 'Doceniasz starsze kino – nie musi być nowe, żeby było warte uwagi.']);
  return tags.length ? tags : [['Widz zrównoważony', 'Twój gust jest wyważony – bez skrajności w żadną stronę.']];
}
function axis(label, left, right, v) {   // v w [0,1]
  const p = Math.round(Math.max(0, Math.min(1, v)) * 100);
  return `<div class="axis"><div class="ax-l"><span>${left}</span><b>${label}</b><span>${right}</span></div><div class="ax-bar"><i style="left:${p}%"></i></div></div>`;
}
function viewProfile() {
  const v = $('#view'), P = profileData();
  if (!P) { v.innerHTML = `<div class="empty">Profil powstanie, gdy będzie co najmniej 20 Twoich ocen dopasowanych do katalogu.</div>`; return; }
  const arch = archetype(P);
  const pct = x => Math.round(x * 100) + '%';
  const lbl = f => featLabel(f);
  const regList = Object.entries(P.reg).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${REGION_NAMES[k] || k} ${pct(n / P.R.length)}`).join(' · ');
  const topThemes = Object.entries(P.themeCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const drift = [];
  if (P.driftEU != null && Math.abs(P.driftEU) > .08) drift.push(P.driftEU > 0 ? 'coraz częściej sięgasz po kino spoza USA' : 'ostatnio częściej wracasz do kina amerykańskiego');
  if (P.driftHeavy != null && Math.abs(P.driftHeavy) > .08) drift.push(P.driftHeavy > 0 ? 'wybierasz coraz poważniejsze tytuły' : 'ostatnio szukasz lżejszych historii');
  if (P.driftTV != null && Math.abs(P.driftTV) > .08) drift.push(P.driftTV > 0 ? 'seriale zajmują coraz więcej miejsca' : 'wracasz do filmów kosztem seriali');
  // zdania o Tobie – ostrożnie, jako hipotezy wynikające z wyborów
  const traits = [];
  if (P.themesM[0]) traits.push(`W filmach najmocniej reagujesz na: <b>${esc(P.themesM.filter(x => x.a > .1).slice(0, 3).map(x => lbl(x.f).replace('temat: ', '')).join(', ') || '—')}</b>.`);
  if (P.themesT[0]) traits.push(`W serialach cenisz: <b>${esc(P.themesT.filter(x => x.a > .1).slice(0, 3).map(x => lbl(x.f).replace('temat: ', '')).join(', ') || '—')}</b>.`);
  if (P.cCrit != null && P.cAud != null) traits.push(P.cCrit > P.cAud + .05 ? 'Twoje oceny są bliżej krytyków niż publiczności – zwracasz uwagę na warsztat i oryginalność, nie tylko na emocje.' : P.cAud > P.cCrit + .05 ? 'Twoje oceny są bliżej publiczności niż krytyków – liczy się dla Ciebie przede wszystkim to, jak film działa na widza.' : 'Twoje oceny równie dobrze zgadzają się z krytykami, jak z publicznością.');
  traits.push(P.sd < 1.3 ? 'Oceniasz spokojnie i konsekwentnie – rzadko skrajnie.' : 'Mocno różnicujesz oceny – wiesz, co Cię zachwyca, a co nie.');
  if (P.lens.length > 20) { const m = P.lens.reduce((a, b) => a + b, 0) / P.lens.length; traits.push(m > 125 ? 'Nie boisz się długich filmów – cierpliwość do wolnego tempa to Twoja mocna strona.' : 'Wolisz zwarte historie – rzadko sięgasz po bardzo długie filmy.'); }
  v.innerHTML = `
  <div class="eyebrow" style="margin-top:6px">Portret widza · ${P.R.length} ocen</div>
  <p class="lead">${esc(arch.slice(0, 3).map((x, i) => i ? x[0].toLowerCase() : x[0]).join(arch.length > 2 ? ', ' : ' i ').replace(/, ([^,]*)$/, ' i $1'))}.</p>
  <div class="note">To interpretacja Twoich wyborów filmowych – nie test psychologiczny.</div>
  <div class="section-h">Twój typ widza</div>
  ${arch.slice(0, 3).map(([n, d]) => `<div class="arch"><b>${n}</b><span>${d}</span></div>`).join('')}
  <div class="section-h">Twoje osie</div>
  <div class="axes">${axis('Wymagania', 'wyrozumiały', 'surowy', .5 - P.generosity / 2)}
  ${axis('Nastrój', 'lekko', 'poważnie', P.gravity)}
  ${axis('Popularność', 'nisza', 'hity', (P.mainstream - 3.5) / 2.5)}
  ${axis('Geografia', 'Hollywood', 'świat', P.nonUS)}
  ${axis('Epoka', 'klasyka', 'nowości', P.medYear ? (P.medYear - 1975) / 50 : .5)}
  ${axis('Różnorodność', 'wierny', 'eklektyczny', P.variety)}
  ${axis('Forma', 'filmy', 'seriale', P.tvShare * 1.6)}</div>
  <div class="section-h">Co mówią o Tobie Twoje wybory</div>
  <div class="arch"><ul class="reasons">${traits.map(t => `<li>${t}</li>`).join('')}</ul></div>
  ${drift.length ? `<div class="note">Zmiana w ostatnich 2 latach: ${drift.join('; ')}.</div>` : ''}
  <div class="section-h">Skąd jest kino, które oglądasz</div><div class="note">${esc(regList)}</div>
  <div class="section-h">Tematy, do których wracasz</div>
  <div class="f-chips">${topThemes.map(([f, n]) => `<span class="chip">${esc(THEME_NAMES[f.slice(1)] || f)} · ${n}</span>`).join('')}</div>
  ${P.dirs.length ? `<div class="section-h">Twoi twórcy</div><table class="mini">${P.dirs.slice(0, 8).map(x => `<tr><td>${esc(x.d)}</td><td>${x.n} tyt.</td><td>śr. ${fmt(x.avg)}</td></tr>`).join('')}</table>` : ''}
  <div class="section-h">Twój kanon</div>
  ${list(P.canon.map(x => x.t), 'mine')}
  <div class="section-h">Wbrew tłumowi – cenisz bardziej niż inni</div>
  <table class="mini">${P.above.map(x => `<tr><td>${esc(x.t.t)}</td><td>portale ${fmt(x.t.fr || x.t.ir)}</td><td class="good">Ty ${x.r}</td></tr>`).join('')}</table>
  <div class="section-h">Rozczarowania – cenisz mniej niż inni</div>
  <table class="mini">${P.below.map(x => `<tr><td>${esc(x.t.t)}</td><td>portale ${fmt(x.t.fr || x.t.ir)}</td><td class="bad">Ty ${x.r}</td></tr>`).join('')}</table>`;
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
  if (f.regions && f.regions.length && !f.regions.includes(regionOf(t))) return false;
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
  const titles = { rec: 'Dla Ciebie', browse: 'Katalog', mine: 'Moje', profile: 'Profil', stats: 'Trafność' };
  $('#title').innerHTML = (S.tab === 'rec' ? `<span class="eyebrow-date">${new Date().toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' })}</span>` : '') + titles[S.tab];
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('#searchBar').hidden = S.tab !== 'browse';
  $('#filterBtn').hidden = !(S.tab === 'rec' || S.tab === 'browse');
  const n = activeFilterCount(); $('#filterCount').hidden = !n; $('#filterCount').textContent = n;
  renderChips();
  ({ rec: viewRec, browse: viewBrowse, mine: viewMine, profile: viewProfile, stats: viewStats })[S.tab]();
}

function renderChips() {
  const el = $('#chips');
  if (S.tab === 'mine' || S.tab === 'stats' || S.tab === 'profile') { el.innerHTML = ''; return; }
  const f = S.f;
  const chips = [
    ['type:all', 'Wszystko', f.type === 'all'], ['type:movie', 'Filmy', f.type === 'movie'], ['type:tv', 'Seriale', f.type === 'tv'],
  ];
  if (S.local.subs.length) chips.push(['subs', 'Moje serwisy', f.onlySubs]);
  chips.push(['eu', 'Europejskie', (f.regions || []).includes('eu')], ['aw:oscar', 'Oscary', f.awards.includes('oscar')], ['pl', 'Polskie', f.country === 'PL'],
    ['new', 'Ostatnie 3 lata', f.yFrom >= new Date().getFullYear() - 3]);
  el.innerHTML = chips.map(([k, l, on]) => `<button class="chip${on ? ' on' : ''}" data-chip="${k}">${l}</button>`).join('');
}

function card(t, mode) {
  const p = S.preds.get(t.id), mine = S.myRatings.get(t.id);
  const poster = t.p ? `style="background-image:url('${IMG}w185${t.p}')"` : '';
  const genres = (t.g || []).slice(0, 2).map(genreName).join(', ');
  const meta = [t.id[0] === 't' ? 'Serial' : null, t.y, genres, t.len ? t.len + ' min' : null].filter(Boolean).join(' · ');
  const sc = [];
  if (t.fr) sc.push(`<span class="sc">Filmweb <b>${fmt(t.fr)}</b></span>`);
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
  return `<button class="card" data-id="${t.id}">
    <div class="poster" ${poster}>${t.p ? '' : `<div class="ph">${esc(t.t)}</div>`}</div>
    <div class="info"><div class="ttl">${esc(t.t)}</div><div class="sub">${esc(meta)}</div>
      ${why ? `<div class="why">${esc(why)}</div>` : aw}
      <div class="scores">${sc.join('')}</div>${provs ? `<div class="provs">${provs}</div>` : ''}</div>${right}</button>`;
}

function list(items, mode) {
  const shown = items.slice(0, S.limit);
  return `<div class="list">${shown.map(t => card(t, mode)).join('')}</div>` +
    (items.length > S.limit ? `<button class="more" data-more>Pokaż więcej (${items.length - S.limit})</button>` : '');
}

function tile(t) {
  const p = S.preds.get(t.id), mine = S.myRatings.get(t.id);
  return `<button class="tile" data-id="${t.id}"><div class="poster" ${t.p ? `style="background-image:url('${IMG}w342${t.p}')"` : ''}>${t.p ? '' : `<div class="ph">${esc(t.t)}</div>`}</div>
    <div class="t1">${esc(t.t)}</div><div class="t2">${mine ? `Twoja ocena <b>${mine.r}</b>` : p != null ? `<b>${fmt(p)}</b> · ${t.y || ''}` : t.y || ''}</div></button>`;
}
function shelf(title, items, more) {
  if (!items.length) return '';
  return `<div class="section-h">${esc(title)}${more ? `<small>${more}</small>` : ''}</div><div class="shelf">${items.map(tile).join('')}</div>`;
}
function hero(t) {
  const bg = t.bd ? `${IMG}w1280${t.bd}` : t.p ? `${IMG}w780${t.p}` : '';
  const why = explain(t, 1)[0] || '';
  const meta = [typ(t) === 't' ? 'Serial' : 'Film', t.y, (t.g || []).slice(0, 2).map(genreName).join(', ')].filter(Boolean).join(' · ');
  return `<button class="hero" data-id="${t.id}" ${bg ? `style="background-image:url('${bg}')"` : ''}>
    <div class="h-top"><div class="eyebrow">Na dziś dla Ciebie</div><h2>${esc(t.t)}</h2></div>
    <div class="h-bot">${why ? `<div class="why">${esc(why)}</div>` : ''}
      <div class="h-meta"><span class="match"><b>${fmt(S.preds.get(t.id))}</b> dla Ciebie</span><span>${esc(meta)}</span></div></div></button>`;
}
function viewRec() {
  const v = $('#view');
  if (!S.model) {
    v.innerHTML = `<div class="empty">Potrzebuję co najmniej 15 Twoich ocen dopasowanych do katalogu, żeby nauczyć się Twojego gustu.<br><br>Teraz mam: ${trainingSamples().length}.</div>`;
    return;
  }
  let items = S.cat.filter(t => passes(t, S.f) && !S.myRatings.has(t.id) && !S.local.hidden[t.id]);
  items = S.f.sort === 'match' ? rankRecs(items) : items.sort(sortFn(S.f.sort));
  if (!items.length) { v.innerHTML = `<div class="empty">Nic nie pasuje do filtrów.</div>`; return; }
  const filtered = activeFilterCount() > 0 || S.f.sort !== 'match';
  let html = '';
  if (!filtered) {
    const used = new Set();
    const pick = (arr, n) => { const out = []; for (const t of arr) { if (out.length >= n) break; if (!used.has(t.id)) { out.push(t); used.add(t.id); } } return out; };
    const top = pick(items.filter(t => t.p || t.bd), 1)[0];
    if (top) html += hero(top);
    html += `<button class="quick" data-quick><i>⚡︎</i><div><b>Szybkie dopasowanie</b><span>10 pytań, które najbardziej wyostrzą rekomendacje</span></div></button>`;
    const mineSubs = S.local.subs.length ? items.filter(t => S.local.subs.some(p => (t.pv || {})[p] && 'sfa'.includes(t.pv[p]))) : [];
    html += shelf('Na Twoich serwisach', pick(mineSubs, 12));
    html += shelf('Z Twojej listy „Chcę zobaczyć”', pick(items.filter(t => S.want.has(t.id)), 12));
    html += shelf('Filmy dla Ciebie', pick(items.filter(t => typ(t) === 'm'), 12));
    html += shelf('Seriale dla Ciebie', pick(items.filter(t => typ(t) === 't'), 12));
    html += shelf('Kino europejskie', pick(items.filter(t => ['eu', 'uk', 'pl'].includes(regionOf(t))), 12));
    html += shelf('Nagradzane, których nie znasz', pick(items.filter(t => (t.aw || []).length), 12));
    html += shelf('Nowości', pick(items.filter(t => t.y >= new Date().getFullYear() - 1), 12));
    html += `<div class="section-h">Wszystkie rekomendacje</div>`;
  } else {
    html += `<div class="note">${items.length.toLocaleString('pl')} tytułów pasuje do filtrów</div>`;
  }
  v.innerHTML = html + list(items, 'rec');
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
  if (!ev) { v.innerHTML = `<div class="empty">Za mało ocen do oceny trafności (potrzeba 30).</div>` + declHTML() + settingsHTML(); return; }
  const pct = x => x == null ? '–' : Math.round(x * 100) + '%';
  const gain = 1 - ev.cv.mae / ev.baseCrowd.mae;
  let html = `<div class="section-h">Jak dobrze model Cię zna</div>
  <div class="stat-grid">
    <div class="stat"><b>±${fmt(ev.cv.mae, 2)}</b><span>średni błąd przewidywania (skala 1–10)</span></div>
    <div class="stat"><b>${pct(ev.cv.within1)}</b><span>przewidywań trafionych z dokładnością do 1 pkt</span></div>
    <div class="stat"><b>${pct(ev.cv.hit)}</b><span>tytułów z prognozą ≥ 7,5, które oceniłeś na 7+</span></div>
    <div class="stat"><b>${fmt(ev.cv.corr, 2)}</b><span>korelacja prognoz z Twoimi ocenami</span></div>
  </div>
  <table class="mini" style="margin-top:10px">
    <tr><td>Filmy (${ev.cvMovie?.n || 0} ocen)</td><td>±${fmt(ev.cvMovie?.mae, 2)}</td></tr>
    <tr><td>Seriale (${ev.cvTv?.n || 0} ocen)</td><td>±${fmt(ev.cvTv?.mae, 2)}</td></tr>
  </table>
  <div class="note">Walidacja krzyżowa: model ocenia każdy tytuł, nie widząc Twojej oceny tego tytułu.${S.tune?.mae ? ` Ustawienia modelu dobrane automatycznie pod Twoje oceny (wygładzanie ×${S.tune.scale}, regularyzacja ${S.tune.ridge}).` : ''}</div>
  <div class="section-h">W porównaniu z prostszymi metodami</div>
  <table class="mini">
    <tr><td>Kinoteka (Twój model)</td><td><b>±${fmt(ev.cv.mae, 2)}</b></td></tr>
    <tr><td>Ocena Filmwebu/IMDb (dopasowana do Twojej średniej)</td><td>±${fmt(ev.baseCrowd.mae, 2)}</td></tr>
    <tr><td>Zawsze Twoja średnia</td><td>±${fmt(ev.baseMean.mae, 2)}</td></tr>
  </table>
  <div class="note">${gain > 0 ? `Model przewiduje Twoje oceny o <b class="good">${Math.round(gain * 100)}% dokładniej</b> niż sama ocena portali.` : `Na razie model nie bije ocen portali – potrzebuje więcej Twoich ocen.`}
  ${S.cat.some(t => t.cf != null) ? ` Gust podobnych widzów (MovieLens) dostępny dla ${S.cat.filter(t => t.cf != null).length.toLocaleString('pl')} filmów.` : ''}</div>`;
  if (ev.time) {
    html += `<div class="section-h">Test w czasie</div>
    <div class="note">Model uczony tylko na ocenach sprzed ${ev.timeFrom} przewidział ${ev.time.n} najnowszych: średni błąd <b>±${fmt(ev.time.mae, 2)}</b>, ${pct(ev.time.within1)} w granicy 1 pkt.</div>
    <table class="mini">${ev.timePairs.slice(-10).reverse().map(([p, r, s]) => `<tr><td>${esc(s.t.t)}</td><td>prognoza ${fmt(p)}</td><td class="${Math.abs(p - r) <= 1 ? 'good' : 'bad'}">Ty ${r}</td></tr>`).join('')}</table>`;
  }
  html += `<div class="section-h">Na żywo</div>`;
  html += ev.live ? `<div class="note">Przewidywania zapisane, zanim oceniłeś tytuł (${ev.live.n}): średni błąd <b>±${fmt(ev.live.mae, 2)}</b>.</div>
    <table class="mini">${ev.livePairs.slice(-15).reverse().map(([p, r, s]) => `<tr><td>${esc(s.t?.t)}</td><td>prognoza ${fmt(p)}</td><td class="${Math.abs(p - r) <= 1 ? 'good' : 'bad'}">Ty ${r}</td></tr>`).join('')}</table>`
    : `<div class="note">Aplikacja zapisała prognozy dla ${Object.keys(S.local.predlog).length.toLocaleString('pl')} tytułów. Gdy obejrzysz coś i ocenisz (na Filmwebie albo tutaj), pojawi się tu porównanie prognozy z Twoją oceną.</div>`;
  html += tasteHTML('m', 'Filmy') + tasteHTML('t', 'Seriale');
  html += declHTML() + settingsHTML();
  v.innerHTML = html;
}

/* Co model wie o guście – osobno dla filmów i seriali */
function tasteHTML(ty, label) {
  const m = S.model; if (!m) return '';
  const sum = new Map(), cnt = new Map();
  m.samples.forEach((s, i) => {
    if (s.real === false || typ(s.t) !== ty) return;
    for (const f of feats(s.t)) if ('gdhr'.includes(f[0])) { sum.set(f, (sum.get(f) || 0) + m.e[i]); cnt.set(f, (cnt.get(f) || 0) + 1); }
  });
  const aff = [...sum].map(([f, s]) => [f, s / (cnt.get(f) + LAMBDA[f[0]]), cnt.get(f)]).filter(x => x[2] >= (ty === 't' ? 2 : 3));
  if (!aff.length) return '';
  aff.sort((a, b) => b[1] - a[1]);
  const top = aff.filter(x => x[1] > .05).slice(0, 8), bot = aff.filter(x => x[1] < -.05).slice(-6).reverse();
  const row = ([f, a, c], cls) => `<tr><td>${esc(featLabel(f))}</td><td>${c} tyt.</td><td class="${cls}">${a > 0 ? '+' : ''}${fmt(a, 2)}</td></tr>`;
  return `<div class="section-h">Czego model nauczył się o Tobie – ${label}</div>
    <div class="note">Oceniasz wyżej, niż wynikałoby z ocen portali:</div><table class="mini">${top.map(x => row(x, 'good')).join('') || '<tr><td>–</td></tr>'}</table>
    <div class="note" style="margin-top:12px">Oceniasz niżej:</div><table class="mini">${bot.map(x => row(x, 'bad')).join('') || '<tr><td>–</td></tr>'}</table>`;
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
  body.innerHTML = `${t.bd ? `<div class="d-hero" style="background-image:url('${IMG}w1280${t.bd}')"></div>` : '<div class="grab"></div>'}<button class="x" data-close aria-label="Zamknij">✕</button>
  <div class="d-head${t.bd ? ' over' : ''}"><div class="poster big" ${t.p ? `style="background-image:url('${IMG}w342${t.p}')"` : ''}></div>
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
  <div class="f-group"><h3>Region produkcji</h3><div class="f-chips">${Object.entries(REGION_NAMES).map(([k, l]) => `<button class="chip${(f.regions || []).includes(k) ? ' on' : ''}" data-arr="regions:${k}">${esc(l)}</button>`).join('')}</div></div>
  <div class="f-group"><h3>Popularność</h3><div class="f-chips">${[[0, 'Dowolna'], [10000, '10 tys.+ głosów'], [100000, '100 tys.+'], [500000, 'Hity 500 tys.+']].map(([v, l]) => `<button class="chip${f.minVotes === v ? ' on' : ''}" data-set="minVotes:${v}">${l}</button>`).join('')}</div></div>
  <div class="f-group"><div class="f-chips"><button class="chip${f.hideSeen ? ' on' : ''}" data-toggle="hideSeen">Ukryj obejrzane i odrzucone</button></div></div>
  <div class="sticky-actions"><button class="btn" data-reset>Wyczyść</button><button class="btn gold" data-close>Pokaż</button></div>`;
  $('#sheet').hidden = false;
}
function yearOpts(sel, now, from) {
  const ys = [1920, 1950, 1960, 1970, 1980, 1990, 2000, 2005, 2010, 2015, 2018, 2020, 2021, 2022, 2023, 2024, 2025, now - 1, now, 2030];
  return [...new Set(ys)].sort((a, b) => a - b).map(y => `<option value="${y}"${y === sel ? ' selected' : ''}>${from ? (y === 1920 ? 'od początku' : 'od ' + y) : (y === 2030 ? 'do dziś' : 'do ' + y)}</option>`).join('');
}

/* ------------------------------------------------------------------ szybkie dopasowanie */
function quickCandidates() {
  // tytuły popularne (pewnie je znasz) i o największej niepewności modelu
  const pool = S.cat.filter(t => !S.myRatings.has(t.id) && !S.local.hidden[t.id] && !(S.local.quickSkip || {})[t.id] && (t.iv || t.tv * 20 || 0) > 40000);
  const sc = t => Math.log10(1 + (t.iv || t.tv * 20)) * ((S.unc && S.unc.get(t.id)) || 1) * (1 + .15 * Math.random());
  return pool.map(t => [sc(t), t]).sort((a, b) => b[0] - a[0]).slice(0, 10).map(x => x[1]);
}
function openQuick() {
  S.quick = { list: quickCandidates(), i: 0, done: 0 };
  renderQuick();
}
function renderQuick() {
  const q = S.quick, body = $('#sheet .sheet-body');
  body.dataset.id = '';
  if (!q || q.i >= q.list.length) {
    body.innerHTML = `<div class="grab"></div><button class="x" data-close aria-label="Zamknij">✕</button><h2 style="font-family:Georgia,serif">Gotowe</h2>
      <p class="note">Dziękuję – ${q ? q.done : 0} odpowiedzi trafiło do modelu. Rekomendacje zostały przeliczone.</p>
      <div class="btn-row"><button class="btn gold" data-quick>Jeszcze 10</button><button class="btn" data-close>Zamknij</button></div>`;
    $('#sheet').hidden = false;
    return;
  }
  const t = q.list[q.i];
  body.innerHTML = `<div class="grab"></div><button class="x" data-close aria-label="Zamknij">✕</button>
    <div class="note" style="margin:0 0 10px">Szybkie dopasowanie · ${q.i + 1} z ${q.list.length}</div>
    <div class="d-head"><div class="poster big" ${t.p ? `style="background-image:url('${IMG}w342${t.p}')"` : ''}></div>
    <div><h2>${esc(t.t)}</h2>${t.ot ? `<div class="d-ot">${esc(t.ot)}</div>` : ''}<div class="d-meta">${[typ(t) === 't' ? 'Serial' : 'Film', t.y].filter(Boolean).join(' · ')}<br>${(t.g || []).map(genreName).join(', ')}<br>${esc((t.d || []).join(', '))}</div></div></div>
    <div class="d-sec"><h3>Widziałem – moja ocena</h3><div class="stars">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<button data-qrate="${n}">${n}</button>`).join('')}</div></div>
    <div class="btn-row"><button class="btn" data-qact="want">Chcę zobaczyć</button><button class="btn" data-qact="no">Nie interesuje mnie</button></div>
    <div class="btn-row" style="margin-top:8px"><button class="btn" data-qact="skip">Nie znam / pomiń</button></div>`;
  $('#sheet').hidden = false;
}
function quickAnswer(kind, val) {
  const q = S.quick, t = q.list[q.i];
  if (kind === 'rate') { S.local.ratings[t.id] = { r: val, date: today() }; q.done++; }
  if (kind === 'want') { S.local.want[t.id] = true; q.done++; }
  if (kind === 'no') { S.local.hidden[t.id] = 1; q.done++; }
  if (kind === 'skip') { S.local.quickSkip = S.local.quickSkip || {}; S.local.quickSkip[t.id] = 1; }
  q.i++;
  saveLocal();
  if (q.i >= q.list.length) { mergeRatings(); buildModel(); render(); }
  renderQuick();
}

/* ------------------------------------------------------------------ deklaracje gustu */
const DECL_GENRES = ['18', '35', '80', '53', '36', '10752', '878', '9648', '10749', '99', '16', '27', '14', '28', '12', '10765', '10759', '10768'];
function declHTML() {
  const d = S.local.decl || {}, part = S.declPart || 'm';
  const chip = (key, label) => {
    const v = d[part + '|' + key] || 0;
    return `<button class="chip decl${v > 0 ? ' on' : v < 0 ? ' neg' : ''}" data-decl="${part}|${key}">${v > 0 ? '♥ ' : v < 0 ? '✕ ' : ''}${esc(label)}</button>`;
  };
  const genres = DECL_GENRES.filter(g => (S.meta.genres || {})[g]).map(g => chip('g' + g, genreName(g)));
  return `<div class="section-h">Mój gust – deklaracje</div>
  <div class="note">Stuknij raz = lubię (♥), drugi raz = nie lubię (✕), trzeci = obojętne. Model traktuje to jako punkt wyjścia i sam weryfikuje na Twoich ocenach.</div>
  <div class="f-chips" style="margin-bottom:10px"><button class="chip${part === 'm' ? ' on' : ''}" data-declpart="m">Filmy</button><button class="chip${part === 't' ? ' on' : ''}" data-declpart="t">Seriale</button></div>
  <div class="f-group"><h3>Region</h3><div class="f-chips">${Object.entries(REGION_NAMES).filter(([k]) => k !== 'other').map(([k, l]) => chip('r' + k, l)).join('')}</div></div>
  <div class="f-group"><h3>Tematy</h3><div class="f-chips">${THEMES.map(([k, l]) => chip('h' + k, l)).join('')}</div></div>
  <div class="f-group"><h3>Gatunki</h3><div class="f-chips">${genres.join('')}</div></div>`;
}

/* ------------------------------------------------------------------ zdarzenia */
function setRating(id, r) {
  S.local.ratings[id] = { r, date: today() };
  delete S.local.hidden[id];
  saveLocal(); mergeRatings(); buildModel();
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-quick],[data-qrate],[data-qact],[data-decl],[data-declpart],[data-id],[data-tab],[data-chip],[data-more],[data-mine],[data-sub],[data-rate],[data-want],[data-hide],[data-set],[data-arr],[data-toggle],[data-reset],[data-close],.sheet-bg,#filterBtn');
  if (!el) return;
  if (el.classList.contains('sheet-bg') || el.dataset.close != null) { closeSheet(); render(); return; }
  if (el.dataset.quick != null) { openQuick(); return; }
  if (el.dataset.qrate) { quickAnswer('rate', +el.dataset.qrate); return; }
  if (el.dataset.qact) { quickAnswer(el.dataset.qact); return; }
  if (el.dataset.declpart) { S.declPart = el.dataset.declpart; render(); return; }
  if (el.dataset.decl) {
    const d = S.local.decl = S.local.decl || {}, k = el.dataset.decl, v = d[k] || 0;
    const nv = v === 0 ? 1 : v === 1 ? -1 : 0;
    if (nv) d[k] = nv; else delete d[k];
    saveLocal(); clearTimeout(S._dt); S._dt = setTimeout(() => { buildModel(); render(); }, 900); render(); return;
  }
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
    if (k === 'eu') { f.regions = f.regions || []; const i = f.regions.indexOf('eu'); i >= 0 ? f.regions.splice(i, 1) : f.regions.push('eu'); }
    if (k === 'new') { const y = new Date().getFullYear() - 3; f.yFrom = f.yFrom >= y ? 1920 : y; }
    S.limit = 40; saveLocal(); render(); return;
  }
  const sid = $('#sheet .sheet-body').dataset.id;
  if (el.dataset.rate) { setRating(sid, +el.dataset.rate); openDetail(sid); return; }
  if (el.dataset.want != null) { S.local.want[sid] = !S.want.has(sid); saveLocal(); mergeRatings(); buildModel(); openDetail(sid); return; }
  if (el.dataset.hide != null) { if (S.local.hidden[sid]) delete S.local.hidden[sid]; else S.local.hidden[sid] = 1; saveLocal(); closeSheet(); buildModel(); render(); return; }
  if (el.dataset.set) { const [k, v] = el.dataset.set.split(':'); S.f[k] = k === 'minVotes' ? +v : v; saveLocal(); openFilters(); return; }
  if (el.dataset.arr) { const [k, v] = el.dataset.arr.split(':'); S.f[k] = S.f[k] || []; const a = S.f[k], i = a.indexOf(v); i >= 0 ? a.splice(i, 1) : a.push(v); saveLocal(); openFilters(); return; }
  if (el.dataset.toggle) { S.f[el.dataset.toggle] = !S.f[el.dataset.toggle]; saveLocal(); openFilters(); return; }
  if (el.dataset.reset != null) { S.f = DEFAULT_F(); saveLocal(); openFilters(); return; }
  if (el.dataset.id && (el.classList.contains('card') || el.classList.contains('tile') || el.classList.contains('hero'))) openDetail(el.dataset.id);
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
