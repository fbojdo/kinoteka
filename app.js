/* Kinoteka – katalog filmów i seriali z rekomendacjami uczącymi się na Twoich ocenach. */
'use strict';

const IMG = 'https://image.tmdb.org/t/p/';
const LS_KEY = 'kinoteka.v1';
const AWARDS = {
  oscar: 'Oscar', oscar_bp: 'Oscar – najlepszy film', oscar_intl: 'Oscar – film międzynarodowy', globe: 'Złoty Glob', bafta: 'BAFTA',
  cannes: 'Cannes', palme: 'Złota Palma', venice: 'Wenecja', lion: 'Złoty Lew', berlin: 'Berlinale', bear: 'Złoty Niedźwiedź',
  efa: 'Europejska Nagroda Filmowa', emmy: 'Emmy', cesar: 'César', goya: 'Goya', orzel: 'Orły', gdynia: 'Gdynia (Złote Lwy)',
  sag: 'SAG', ind: 'Independent Spirit', sundance: 'Sundance', tiff: 'Toronto (TIFF)', kv: 'Karlowe Wary', sansebastian: 'San Sebastián',
  critics: 'Critics’ Choice', annie: 'Annie'
};
const FESTIVALS = [['oscar', 'oscar_bp', 'oscar_intl'], ['cannes', 'palme'], ['venice', 'lion'], ['berlin', 'bear'], ['globe'], ['bafta'], ['efa'],
  ['gdynia'], ['orzel'], ['cesar'], ['goya'], ['sundance'], ['tiff'], ['kv'], ['sansebastian'], ['emmy'], ['sag'], ['critics'], ['ind'], ['annie']];
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
  type: 'all', awSel: {}, moods: [], periods: [], lens: [], themes: [], sure: false, mini: false, crit: [], critRec: false, minCra: 0, genres: [], regions: [], yFrom: 1920, yTo: 2030, rtMax: 0, provs: [], onlySubs: false, awards: [], awardMode: 'win',
  minFw: 0, minImdb: 0, minRt: 0, minMc: 0, minVotes: 0, country: '', hideSeen: true, sort: 'match'
});

function loadLocal() {
  try { Object.assign(S.local, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) { /* tryb prywatny */ }
  S.f = Object.assign(DEFAULT_F(), S.local.filters || {});
  backupDaily();
  for (const k of ['moods', 'periods', 'lens', 'themes', 'crit', 'regions', 'provs', 'genres', 'awards']) if (!Array.isArray(S.f[k])) S.f[k] = [];
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
    try { S.critics = await getJSON('data/critics.json'); } catch (e) { S.critics = []; }
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
  seedTaste();
  try { navigator.storage?.persist?.(); } catch (e) { /* brak */ }
  try {   // dane przeniesione z Safari (jednorazowo, łączone – nic nie ginie)
    const sd = await getJSON('seed/local.json');
    S.seed = sd && sd.local || null;   // stałe źródło – wczytywane przy każdym starcie, jak oceny z Filmwebu
    if (sd && sd.id && !(S.local.seeds || {})[sd.id]) { Object.assign(S.local, mergeLocal(S.local, sd.local)); S.local.seeds = { ...(S.local.seeds || {}), [sd.id]: today() }; saveLocal(); }
  } catch (e) { /* brak pliku */ }
  trackFilmwebChanges();
  mergeRatings();
  buildModel();
  render();
}

/* Historia zmian ocen: {id: [[ocena, data, źródło], ...]} – nic nie ginie przy zmianie */
function histPush(id, r, date, src) {
  const H = S.local.rhist = S.local.rhist || {}, h = H[id] = H[id] || [];
  const last = h[h.length - 1];
  if (last && last[0] === r) return;
  h.push([r, date || today(), src]);
}
function trackFilmwebChanges() {   // oceny zmienione na Filmwebie od ostatniego otwarcia
  const snap = S.local.fwSnap, now = {};
  for (const r of S.me.ratings || []) if (r.id && r.r) now[r.id] = [r.r, r.date];
  if (snap) for (const [id, [r, d]] of Object.entries(now)) {
    const old = snap[id];
    if (old != null && old !== r) { if (!(S.local.rhist || {})[id]) histPush(id, old, '', 'fw'); histPush(id, r, d || today(), 'fw'); }
    else if (old == null && (S.local.rhist || {})[id]) histPush(id, r, d || today(), 'fw');
  }
  S.local.fwSnap = Object.fromEntries(Object.entries(now).map(([k, v]) => [k, v[0]]));
  saveLocal();
}
function mergeRatings() {
  S.myRatings.clear();
  for (const [id, r] of Object.entries((S.seed || {}).ratings || {})) if (!S.local.ratings[id]) S.local.ratings[id] = r;
  for (const [id, v] of Object.entries((S.seed || {}).want || {})) if (!(id in S.local.want)) S.local.want[id] = v;
  for (const r of S.me.ratings || []) if (r.id && r.r) S.myRatings.set(r.id, { r: r.r, date: r.date || '2000-01-01', src: 'fw', fav: r.fav });
  for (const [id, r] of Object.entries(S.local.ratings)) {
    const cur = S.myRatings.get(id);
    if (!cur || (r.date || '') >= (cur.date || '')) S.myRatings.set(id, { r: r.r, date: r.date, src: 'app' });
  }
  applyFwImport();
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
  ['spy', 'szpiedzy i wywiad', /(\bspy\b|spies|espionage|secret agent|intelligence agency|\bmi6\b|\bkgb\b|\bcia\b|mossad|double agent|undercover)/i],
  ['terror', 'terroryzm', /(terroris|hostage|bombing|counterterror|counter-terror|jihad|hijack)/i],
  ['superhero', 'superbohaterowie', /(superhero|super hero|marvel cinematic|marvel comics|dc comics|dc extended|based on comic|comic book|superpower|super power)/i],
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
    zr != null ? zr - (zi ?? q) : 0, zm != null ? zm - (zi ?? q) : 0,    // krytycy vs publiczność
    heavinessRaw(t),
    critSignal(t) ?? 0, t.cra ? (t.cra - 6.5) / 1.2 : 0,
  ];
  return t._d;
}

/* Deklaracje użytkownika -> pseudo-obserwacje na cechach */
function declPriors() {
  const out = new Map();
  rejectPriors(out);   // klucz cechy (z prefiksem typu lub bez) -> [suma, liczba]
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
      const wf = s.ag ? (s.ag.has(f[0]) ? 2.2 : .7) : 1;   // „Co zdecydowało?” – wskazane grupy cech uczą mocniej
      add(f, e[i] * W[i] * wf, W[i] * wf); add(ty + '|' + f, e[i] * W[i] * wf, W[i] * wf);
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
/* „Więcej takich jak…” – podobieństwo do 1–3 wzorców (cechy ważone + ton + epoka), z domieszką dopasowania do Ciebie */
function simTo(a, t) {
  const fa = new Set(feats(a)); let o = 0;
  for (const f of feats(t)) if (fa.has(f)) o += SIMW[f[0]] || 1;
  const same = typ(a) === typ(t) ? SIMW.t : 0;
  const jac = (o + same) / (a._fn + t._fn - o - same);
  const tone = 1 - Math.abs(heaviness(a) - heaviness(t)) / 2;
  const era = a.y && t.y ? Math.max(0, 1 - Math.abs(a.y - t.y) / 40) : .5;
  return jac * .7 + tone * .2 + era * .1;
}
function likeResults(ids) {
  const A = ids.map(i => S.byId.get(i)).filter(Boolean); if (!A.length) return [];
  const out = [];
  for (const t of S.cat) {
    if (ids.includes(t.id) || S.myRatings.has(t.id) || S.local.hidden[t.id] || tasteBlocked(t)) continue;
    const sims = A.map(a => simTo(a, t)), sim = sims.reduce((x, y) => x + y, 0) / sims.length * .6 + Math.min(...sims) * .4;
    if (sim < .12) continue;
    const p = S.preds.get(t.id) ?? 6.5;
    out.push([sim * 10 + (p - 7) * .45 - famPenalty(t) * .5, sim, t]);
  }
  out.sort((a, b) => b[0] - a[0]);
  const top = out.slice(0, 40), mx = top[0]?.[1] || 1;
  return top.map(([, sim, t]) => (t._like = Math.round(sim / mx * 100), t));
}
function openLike(addId) {
  S.like = S.like || [];
  if (addId && !S.like.includes(addId)) { S.like.push(addId); if (S.like.length > 3) S.like.shift(); }
  renderLike();
}
function renderLike() {
  const body = $('#sheet .sheet-body'); body.dataset.id = '';
  const q = (S.likeQ || '').toLowerCase();
  const sugg = q.length >= 2 ? search(q).slice(0, 8) : [...S.myRatings.entries()].filter(([, r]) => r.r >= 9).map(([id]) => S.byId.get(id)).filter(Boolean).slice(0, 8);
  const res = likeResults(S.like);
  body.innerHTML = `<div class="grab"></div><button class="x" data-close aria-label="Zamknij">✕</button>
  <h2 style="font:700 28px var(--sfd);margin:4px 0 6px">Więcej takich jak…</h2>
  <div class="note">Wybierz od 1 do 3 tytułów-wzorców. Szukam podobnych tonem, tematem, twórcami i stylem – i dopasowanych do Ciebie.</div>
  <div class="f-chips" style="margin:10px 0">${S.like.map(id => `<button class="chip on" data-likex="${id}">${esc(S.byId.get(id)?.t || id)} ✕</button>`).join('') || '<span class="note" style="margin:0">Brak wzorców</span>'}</div>
  <input id="likeq" class="search" type="search" placeholder="Szukaj tytułu-wzorca…" value="${esc(S.likeQ || '')}" autocomplete="off">
  <div class="f-chips" style="margin:8px 0 4px">${sugg.filter(t => !S.like.includes(t.id)).map(t => `<button class="chip" data-likeadd="${t.id}">+ ${esc(t.t)}${t.y ? ` <small>${t.y}</small>` : ''}</button>`).join('')}</div>
  ${q.length < 2 ? '<div class="note" style="margin:0 0 6px">Podpowiedzi: Twoje filmy na 9–10.</div>' : ''}
  ${res.length ? `<div class="section-h">Podobne · ${res.length}</div>${list(res, 'like')}` : ''}`;
  $('#sheet').hidden = false;
}

/* Co zdecydowało o ocenie → które grupy cech mają się z tej oceny uczyć mocniej */
const ASPECTS = {
  temat: ['Temat', ['h', 'k']], fabula: ['Scenariusz i fabuła', ['w', 'k']], rezyseria: ['Reżyseria', ['d']],
  aktorzy: ['Aktorstwo', ['a']], klimat: ['Klimat i zdjęcia', ['c', 'r', 'l', 'y']], gatunek: ['Gatunek', ['g']],
  tempo: ['Tempo', ['g', 'y']], zakonczenie: ['Zakończenie', ['w', 'd']],
};
function aspectsHTML(id) {
  const mine = S.myRatings.get(id); if (!mine) return '';
  const cur = new Set((S.local.aspects || {})[id] || []), good = mine.r >= (S.mu || 7);
  return `<div class="surp"><span>${good ? 'Co zdecydowało, że Ci się podobał?' : 'Co zawiodło?'} <small>(możesz kilka)</small></span>
    <div class="f-chips">${Object.entries(ASPECTS).map(([k, [l]]) => `<button class="chip${cur.has(k) ? ' on' : ''}" data-asp="${k}">${l}</button>`).join('')}</div></div>`;
}
function aspectStats() {
  const c = {}, A = S.local.aspects || {};
  for (const [id, as] of Object.entries(A)) { const r = S.myRatings.get(id); if (!r) continue; for (const a of as) { c[a] = c[a] || [0, 0]; c[a][r.r >= (S.mu || 7) ? 0 : 1]++; } }
  return Object.entries(c).sort((a, b) => b[1][0] + b[1][1] - a[1][0] - a[1][1]);
}
function trainingSamples(beforeDate) {
  const out = [], adj = duelAdjust();
  for (const [id, r] of S.myRatings) {
    const t = S.byId.get(id);
    const sp = (S.local.surp || {})[id];   // zaskoczenie po seansie: tytuł mówi o guście więcej, niż widać po etykietach
    const as = (S.local.aspects || {})[id], ag = as && as.length ? new Set(as.flatMap(a => ASPECTS[a]?.[1] || [])) : null;
    if (t && (!beforeDate || (r.date || '') < beforeDate)) out.push({ t, r: r.r + (adj[id] || 0), date: r.date, id, ag, w: recencyW(r.date) * (sp ? 1.4 : sp === 0 ? 1.05 : 1) * (ag ? 1.15 : 1) });
  }
  return out;
}
/** Słabe sygnały: „Chcę zobaczyć" (+) i „Nie dla mnie" (−) */
function weakSamples(mu) {
  const out = [];
  for (const id of S.want || []) { const t = S.byId.get(id); if (t && !S.myRatings.has(id)) out.push({ t, r: mu + .9, w: .25, id, real: false }); }
  const RW = { heavy: .5, light: .5, theme: .55, creator: .55, genre: .55, later: .1 };
  for (const id of Object.keys(S.local.hidden || {})) {
    const t = S.byId.get(id); if (!t || !S.local.hidden[id] || S.myRatings.has(id)) continue;
    const why = (S.local.rejects || {})[id];
    out.push({ t, r: mu - 2.2, w: why ? RW[why] ?? .45 : .45, id, real: false });
  }
  return out;
}

/* Autostrojenie: wybiera siłę wygładzania gustu i regularyzację pod Twoje dane (3-krotna CV) */
function autotune(real) {
  const key = Math.floor(real.length / 10) + ':' + Math.floor(Object.keys(S.local.hidden || {}).length / 10) + ':' + Object.keys(S.local.decl || {}).length + ':' + Object.keys(S.local.taste || {}).length;
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
  S.preds.clear(); S.reasons.clear(); S.unc = new Map(); S._fam = null;
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
    t._rh = null;
    let { p, gsr, unc } = m.predict(t, idx.get(t.id));
    const q = quality(t); if (q) p = Math.min(p, q + 2.6);   // bez skrajnych wystrzałów ponad ocenę widzów
    S.preds.set(t.id, p); S.reasons.set(t.id, gsr); S.unc.set(t.id, unc);
  }
  // siła Twoich reguł gustu – dobrana tak, by najlepiej tłumaczyła Twoje oceny (min. 0,5, bo to Twoja deklaracja)
  const hasRules = Object.values(S.local.taste || {}).some(Boolean);
  let best = [0, 1e9], base = null;
  for (const k of hasRules ? [0, .25, .5, .75, 1, 1.25, 1.5] : [0]) {
    let e = 0; for (const s of real) e += Math.abs(Math.max(1, Math.min(10, S.preds.get(s.id) + k * tasteAdj(s.t))) - s.r);
    e /= real.length; if (k === 0) base = e; if (e < best[1]) best = [k, e];
  }
  S.ruleK = hasRules ? Math.max(.5, best[0]) : 0;
  S.ruleGain = base ? 1 - best[1] / base : 0;
  if (S.ruleK) for (const t of S.cat) S.preds.set(t.id, adjP(t, S.preds.get(t.id)));
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
    for (const s of test) { const p0 = m.predict(s.t).p, q = quality(s.t); cvPairs.push([adjP(s.t, q ? Math.min(p0, q + 2.6) : p0), s.r, s, p0]); }
  }
  res.cv = metrics(cvPairs);
  res.cvRaw = metrics(cvPairs.map(x => [x[3], x[1]]));
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
    const pairs = dated.slice(cut).map(s => [adjP(s.t, m.predict(s.t).p), s.r, s]);
    res.time = metrics(pairs); res.timeFrom = dated[cut].date; res.timePairs = pairs;
  }
  const live = [];
  for (const [id, [p, d]] of Object.entries(S.local.predlog)) {
    const r = S.myRatings.get(id);
    if (r && r.date && r.date >= d) live.push([p, r.r, { t: S.byId.get(id), r: r.r, date: r.date }]);
  }
  res.live = live.length ? metrics(live) : null; res.livePairs = live;
  // czy z czasem trafia lepiej: uczenie na wszystkim sprzed okresu, test na ocenach z okresu
  if (dated.length >= 60) {
    const start = Math.floor(dated.length * .4), B = Math.min(6, Math.floor((dated.length - start) / 12)), size = Math.floor((dated.length - start) / B);
    res.curve = [];
    for (let b = 0; b < B; b++) {
      const lo = start + b * size, hi = b === B - 1 ? dated.length : lo + size;
      const trn = dated.slice(0, lo), test = dated.slice(lo, hi);
      const m = train([...trn, ...weak]);
      const cr = trn.filter(s => s.t.fr || s.t.ir), o = cr.reduce((a, s) => a + s.r - (s.t.fr || s.t.ir), 0) / Math.max(1, cr.length);
      const mm = metrics(test.map(s => [m.predict(s.t).p, s.r]));
      const cm = metrics(test.filter(s => s.t.fr || s.t.ir).map(s => [(s.t.fr || s.t.ir) + o, s.r]));
      res.curve.push({ from: test[0].date, to: test.at(-1).date, n: lo, mae: mm.mae, crowd: cm?.mae, w1: mm.within1 });
    }
  }
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
  if (k === 'g') return genreName(v) ? 'gatunek ' + genreName(v).toLowerCase() : null;
  if (k === 'h') return 'temat: ' + (THEME_NAMES[v] || v);
  if (k === 'k') return (S.meta.keywords || {})[v] ? 'motyw „' + S.meta.keywords[v] + '"' : null;
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
  const cs = critSignal(t);
  const rh = ruleHits(t).filter(([, lv]) => lv === 'like' || lv === 'love').map(([k]) => tasteLabel(k).toLowerCase());
  if (rh.length) out.push('Twój gust: ' + rh.slice(0, 3).join(', '));
  if (critRecommended(t)) { const best = t.ctop.slice().sort((a, b) => b[1] - a[1])[0]; out.push(`Twoi krytycy go cenią – ${S.critics[best[0]]?.name || ''} ${best[1]}/10`); }
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
function familiarity() {
  if (S._fam) return S._fam;
  const dec = {}, n = Math.max(1, S.myRatings.size);
  for (const id of S.myRatings.keys()) { const t = S.byId.get(id); if (t && t.y) { const d = Math.floor(t.y / 10); dec[d] = (dec[d] || 0) + 1; } }
  S._fam = { dec, n };
  return S._fam;
}
function famPenalty(t) {
  // tytuły z epok, których prawie nie oglądasz, wymagają mocniejszych dowodów
  const F = familiarity(); if (!t.y) return .2;
  const share = (F.dec[Math.floor(t.y / 10)] || 0) / F.n;
  const votes = t.iv || t.tv * 20 || 0;
  return (share < .04 ? .9 * (.04 - share) / .04 : 0) + (votes < 15000 ? .3 : 0);
}
function rankRecs(items) {
  const score = t => (S.preds.get(t.id) ?? 0) - .35 * ((S.unc && S.unc.get(t.id)) || 0) - famPenalty(t) + (t.pop > 30 ? .02 : 0);
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
/* ================================================================== STATYSTYKI ocen */
function statsHTML() {
  const ty = S.statType || 'all';
  const R = [...S.myRatings.entries()].map(([id, r]) => ({ t: S.byId.get(id), r: r.r, date: r.date })).filter(x => x.t && (ty === 'all' || typ(x.t) === ty));
  const segT = `<div class="seg" style="margin:0 0 14px">${[['all', 'Wszystko'], ['m', 'Filmy'], ['t', 'Seriale']].map(([k, l]) => `<button data-stat="${k}" class="${ty === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  if (R.length < 5) return segT + `<div class="empty">Za mało ocen.</div>`;
  const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const rs = R.map(x => x.r).sort((a, b) => a - b), mu = mean(rs);
  const med = rs.length % 2 ? rs[(rs.length - 1) / 2] : (rs[rs.length / 2 - 1] + rs[rs.length / 2]) / 2;
  const sd = Math.sqrt(mean(rs.map(r => (r - mu) ** 2)));
  const cr = R.filter(x => quality(x.t)), gen = mean(cr.map(x => x.r - quality(x.t)));
  const sgn = x => (x > 0 ? '+' : x < 0 ? '−' : '±') + fmt(Math.abs(x));
  const tile = (v, l) => `<div class="st-tile"><b>${v}</b><span>${l}</span></div>`;
  const nm = R.filter(x => typ(x.t) === 'm').length, nt = R.length - nm;
  // grupowanie: klucze → [liczba, średnia, różnica vs widzowie]
  const group = (keysOf, min = 1) => {
    const g = new Map();
    for (const x of R) for (const k of keysOf(x)) { if (k == null || k === '') continue; const a = g.get(k) || g.set(k, []).get(k); a.push(x); }
    return [...g].filter(([, a]) => a.length >= min).map(([k, a]) => {
      const c = a.filter(x => quality(x.t));
      return { k, n: a.length, avg: mean(a.map(x => x.r)), vs: c.length >= 2 ? mean(c.map(x => x.r - quality(x.t))) - gen : null };
    });
  };
  // wiersze słupków: etykieta | słupek (liczba) | liczba · średnia | vs widzowie
  const bars = (rows, label, opts = {}) => {
    if (!rows.length) return '';
    const mx = Math.max(...rows.map(r => r.n));
    return `<div class="sbars">${rows.map(r => `<div class="sbar" title="${esc(label(r.k))}: ${r.n} ocen, średnia ${fmt(r.avg)}">
      <span class="sl">${esc(label(r.k))}</span><span class="sb"><i style="width:${Math.max(4, r.n / mx * 100)}%"></i></span>
      <span class="sn">${r.n}</span><span class="sa">${fmt(r.avg)}</span>${opts.vs ? `<span class="sv ${r.vs == null ? '' : r.vs > .15 ? 'good' : r.vs < -.15 ? 'bad' : ''}">${r.vs == null ? '' : sgn(r.vs)}</span>` : ''}</div>`).join('')}</div>`;
  };
  const head = (t, sub) => `<div class="section-h">${t}</div>${sub ? `<div class="note" style="margin-top:-4px">${sub}</div>` : ''}`;
  const colhead = vs => `<div class="sbar shead"><span class="sl"></span><span class="sb"></span><span class="sn">ocen</span><span class="sa">śr.</span>${vs ? '<span class="sv">vs widzowie</span>' : ''}</div>`;
  // rozkład 1–10
  const dist = Array.from({ length: 10 }, (_, i) => rs.filter(r => r === i + 1).length), dmx = Math.max(...dist);
  const distHTML = `<div class="sdist">${dist.map((n, i) => `<div title="${i + 1}: ${n} ocen"><span class="dn">${n || ''}</span><i style="height:${n ? Math.max(3, n / dmx * 100) : 0}%"></i><b>${i + 1}</b></div>`).join('')}</div>`;
  const dec = group(x => [x.t.y ? Math.floor(x.t.y / 10) * 10 : null]).sort((a, b) => a.k - b.k);
  const yrs = group(x => [x.t.y]).filter(r => r.k >= new Date().getFullYear() - 14).sort((a, b) => b.k - a.k);
  const gen_ = group(x => (x.t.g || []).map(String), 3).sort((a, b) => b.n - a.n);
  const reg = group(x => [regionOf(x.t)], 2).sort((a, b) => b.n - a.n);
  const ctry = group(x => (x.t.c || []).slice(0, 1), 2).sort((a, b) => b.n - a.n).slice(0, 14);
  const ry = group(x => [x.date && x.date > '2001' ? x.date.slice(0, 4) : null]).sort((a, b) => b.k.localeCompare(a.k));
  const lenB = x => { const L = x.t.len; if (!L) return null; if (typ(x.t) === 't') return L <= 30 ? 'odcinek do 30 min' : L <= 55 ? 'odcinek 30–55 min' : 'odcinek ponad 55 min'; return L < 95 ? 'do 95 min' : L < 120 ? '95–120 min' : L < 150 ? '120–150 min' : 'ponad 150 min'; };
  const lens = group(x => [lenB(x)]); const LO = ['do 95 min', '95–120 min', '120–150 min', 'ponad 150 min', 'odcinek do 30 min', 'odcinek 30–55 min', 'odcinek ponad 55 min']; lens.sort((a, b) => LO.indexOf(a.k) - LO.indexOf(b.k));
  const dirs = group(x => x.t.d || [], 2).sort((a, b) => b.n - a.n || b.avg - a.avg).slice(0, 12);
  const acts = group(x => (x.t.a || []).slice(0, 4), 3).sort((a, b) => b.n - a.n || b.avg - a.avg).slice(0, 12);
  const aw = group(x => [(x.t.aw || []).length ? 'Nagrodzone' : (x.t.an || []).length ? 'Tylko nominowane' : 'Bez nagród']).sort((a, b) => b.avg - a.avg);
  const pop = group(x => { const v = x.t.iv || (x.t.tv || 0) * 20; return [v >= 500000 ? 'hity (500 tys.+ głosów)' : v >= 100000 ? 'popularne (100–500 tys.)' : v >= 20000 ? 'średnio znane (20–100 tys.)' : 'niszowe (do 20 tys.)']; });
  const POPO = ['hity (500 tys.+ głosów)', 'popularne (100–500 tys.)', 'średnio znane (20–100 tys.)', 'niszowe (do 20 tys.)']; pop.sort((a, b) => POPO.indexOf(a.k) - POPO.indexOf(b.k));
  const best = R.slice().sort((a, b) => b.r - a.r || (quality(b.t) || 0) - (quality(a.t) || 0));
  return segT + `<div class="st-tiles">
    ${tile(R.length, ty === 'all' ? `ocen · ${nm} filmów, ${nt} seriali` : 'ocen')}${tile(fmt(mu, 2), 'średnia')}${tile(fmt(med), 'mediana')}
    ${tile(Math.round(rs.filter(r => r >= 9).length / rs.length * 100) + '%', 'ocen 9–10')}${tile(sgn(gen), 'vs średnia portali')}${tile(fmt(sd, 2), 'rozrzut ocen')}</div>
  ${head('Rozkład ocen')}${distHTML}
  ${head('Dekady produkcji')}${colhead(true)}${bars(dec, k => k + '.', { vs: true })}
  ${head('Roczniki – ostatnie 15 lat')}${colhead()}${bars(yrs, k => String(k))}
  ${head('Gatunki', 'Min. 3 oceny · „vs widzowie” – o ile oceniasz wyżej/niżej niż portale, ponad swoją zwykłą różnicę.')}${colhead(true)}${bars(gen_, k => genreName(k) || k, { vs: true })}
  ${head('Regiony')}${colhead(true)}${bars(reg, k => REGION_NAMES[k] || k, { vs: true })}
  ${head('Kraje (główny kraj produkcji)')}${colhead(true)}${bars(ctry, k => COUNTRY[k] || k, { vs: true })}
  ${head('Długość')}${colhead()}${bars(lens, k => k)}
  ${head('Popularność tytułu')}${colhead(true)}${bars(pop, k => k, { vs: true })}
  ${head('Nagrody')}${colhead(true)}${bars(aw, k => k, { vs: true })}
  ${dirs.length ? head('Reżyserzy (min. 2 tytuły)') + colhead() + bars(dirs, k => k) : ''}
  ${acts.length ? head('Aktorzy (min. 3 tytuły)') + colhead() + bars(acts, k => k) : ''}
  ${head('Kiedy oceniałeś', 'Rok wystawienia oceny.')}${colhead()}${bars(ry, k => k)}
  ${head('Najwyżej i najniżej')}
  <table class="mini">${[...best.slice(0, 5), ...best.slice(-5)].map((x, i) => `${i === 5 ? '<tr><td colspan="3" style="color:var(--tx2)">…</td></tr>' : ''}<tr class="row-link" data-id="${x.t.id}"><td>${esc(x.t.t)} <small style="color:var(--tx2)">${x.t.y || ''}</small></td><td>portale ${fmt(quality(x.t))}</td><td><b>${x.r}</b></td></tr>`).join('')}</table>`;
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
  const part = S.profPart || 'portret';
  if (part === 'stat') { v.innerHTML = `<div class="seg" style="margin:4px 0 14px">${[['portret', 'Portret'], ['gust', 'Mój gust'], ['hist', 'Historia'], ['stat', 'Statystyki']].map(([k, l]) => `<button data-prof="${k}" class="${part === k ? 'on' : ''}">${l}</button>`).join('')}</div>` + statsHTML(); return; }
  const seg = `<div class="seg" style="margin:4px 0 14px">${[['portret', 'Portret'], ['gust', 'Mój gust'], ['hist', 'Historia'], ['stat', 'Statystyki']].map(([k, l]) => `<button data-prof="${k}" class="${part === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  if (part === 'gust') {
    const asp = aspectStats();
    v.innerHTML = seg + declHTML() + (asp.length ? `<div class="section-h">Co decyduje o Twoich ocenach</div>
    <table class="mini">${asp.map(([k, [g, b]]) => `<tr><td>${ASPECTS[k][0]}</td><td class="good">${g ? '▲ ' + g : ''}</td><td class="bad">${b ? '▼ ' + b : ''}</td></tr>`).join('')}</table>` : '') + `
    <div class="section-h">Skąd jest kino, które oglądasz</div><div class="note">${esc(regList)}</div>
    <div class="section-h">Tematy, do których wracasz</div>
    <div class="f-chips">${topThemes.map(([f, n]) => `<span class="chip">${esc(THEME_NAMES[f.slice(1)] || f)} · ${n}</span>`).join('')}</div>
    <div class="note" style="margin-top:18px">Poniżej: czego model nauczył się z Twoich ocen – niezależnie od reguł powyżej.</div>
    ${tasteHTML('m', 'Filmy')}${tasteHTML('t', 'Seriale')}`;
    return;
  }
  if (part === 'hist') {
    v.innerHTML = seg + `
    <div class="section-h">Twój kanon</div>
    ${list(P.canon.map(x => x.t), 'mine')}
    ${P.dirs.length ? `<div class="section-h">Twoi twórcy</div><table class="mini">${P.dirs.slice(0, 8).map(x => `<tr><td>${esc(x.d)}</td><td>${x.n} tyt.</td><td>śr. ${fmt(x.avg)}</td></tr>`).join('')}</table>` : ''}
    ${(S.critics || []).length ? `<div class="section-h">Twoi krytycy</div><div class="note">Krytycy Filmwebu, których oceny są najbliższe Twoim (wspólne filmy · zgodność w granicy 1 pkt).</div>
      <table class="mini">${S.critics.map((c, i) => `<tr><td><b>${i + 1}. ${esc(c.name)}</b><br><small style="color:var(--tx2)">${esc(c.pub || '')}</small></td><td>${c.n} wsp.</td><td>${Math.round(c.agree * 100)}%</td></tr>`).join('')}</table>` : ''}
    <div class="section-h">Wbrew tłumowi – cenisz bardziej niż inni</div>
    <table class="mini">${P.above.map(x => `<tr><td>${esc(x.t.t)}</td><td>portale ${fmt(x.t.fr || x.t.ir)}</td><td class="good">Ty ${x.r}</td></tr>`).join('')}</table>
    <div class="section-h">Rozczarowania – cenisz mniej niż inni</div>
    <table class="mini">${P.below.map(x => `<tr><td>${esc(x.t.t)}</td><td>portale ${fmt(x.t.fr || x.t.ir)}</td><td class="bad">Ty ${x.r}</td></tr>`).join('')}</table>
    ${histHTML()}`;
    return;
  }
  v.innerHTML = seg + `
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
  <button class="quick" data-prof="gust" style="margin-top:14px"><i style="background:linear-gradient(135deg,#30d158,#0a84ff)">♥</i><div><b>Mój gust</b><span>${Object.values(S.local.taste || {}).filter(Boolean).length} reguł i to, czego model nauczył się z Twoich ocen</span></div></button>`;
}

/* ================================================================== NASTRÓJ: lekko ↔ ciężko */
const G_LIGHT = { 35: 1, 10751: 1, 16: .8, 10402: .7, 10749: .5, 12: .5, 14: .3, 10762: 1, 10759: .3, 10765: .2, 28: .2 };
const G_HEAVY = { 10752: 1, 18: .6, 36: .6, 80: .45, 53: .5, 27: .4, 99: .35, 9648: .3, 10768: .8 };
const H_HEAVY = { war: 1, psyche: .7, society: .6, faith: .4, truth: .4, politics: .5, law: .3, medicine: .4, crime: .3, history: .3 };
const H_LIGHT = { love: .5, satire: .3, sport: .3, adventure: .3, art: .2, youth: .2 };
function heavinessRaw(t) { return heaviness(t); }
function heaviness(t) {   // ~ -1 (lekko) … +1 (ciężko)
  if (t._hv != null) return t._hv;
  let l = 0, h = 0;
  for (const g of t.g || []) { l += G_LIGHT[g] || 0; h += G_HEAVY[g] || 0; }
  for (const f of feats(t)) if (f[0] === 'h') { l += H_LIGHT[f.slice(1)] || 0; h += (H_HEAVY[f.slice(1)] || 0) * .6; }
  t._hv = Math.max(-1, Math.min(1, (h - l) / 1.6));
  return t._hv;
}
const PERIODS = { any: ['Dowolnie'], new: ['Nowości'], y5: ['Ostatnie 5 lat'], y2000: ['Od 2000'], y90: ['Lata 80–90.'], classic: ['Klasyka (do 1979)'] };
function inPeriod(t, p) {
  const y = t.y || 0, now = new Date().getFullYear();
  return p === 'any' || (p === 'new' && y >= now - 1) || (p === 'y5' && y >= now - 5) || (p === 'y2000' && y >= 2000) || (p === 'y90' && y >= 1980 && y < 2000) || (p === 'classic' && y && y < 1980);
}
const LENB = { any: 'Dowolnie', short: 'Krótko', mid: 'Średnio', long: 'Długo' };
function inLen(t, b) {
  if (b === 'any' || !t.len) return b === 'any';
  const tv = typ(t) === 't', L = t.len;
  if (b === 'short') return tv ? L <= 30 : L <= 100;
  if (b === 'mid') return tv ? L > 30 && L <= 55 : L > 100 && L <= 130;
  return tv ? L > 55 : L > 130;
}
function critSignal(t) {   // ważone odchylenie ocen „Twoich” krytyków od ich średniej
  if (!t.ctop || !(S.critics || []).length) return null;
  let num = 0, den = 0;
  for (const [i, v] of t.ctop) { const c = S.critics[i]; if (!c) continue; num += c.score * (v - c.mean); den += c.score; }
  return den ? num / (den + .3) : null;
}
function critAvg(t) {      // średnia ocen Twoich krytyków (ważona dopasowaniem)
  if (!t.ctop || !(S.critics || []).length) return null;
  let n = 0, d = 0;
  for (const [i, v] of t.ctop) { const c = S.critics[i]; if (!c) continue; n += c.score * v; d += c.score; }
  return d ? n / d : null;
}
function critRecommended(t) {   // polecają: wysoko u Twoich krytyków + co najmniej 7,0 dopasowania do Ciebie
  const a = critAvg(t);
  return a != null && (a >= 7.5 || (critSignal(t) ?? 0) >= .3) && (S.preds.get(t.id) ?? 0) >= 7;
}
function isSure(t) { const p = S.preds.get(t.id) || 0, u = (S.unc && S.unc.get(t.id)) || 9; return p - .5 * u >= 7.6; }

/* ================================================================== MÓJ GUST – jawne reguły
   Klucze: s:specjalne, r:region, c:kraj, g:gatunek, h:temat. Poziomy: never (nie pokazuj),
   top (tylko wybitne), dislike, like, love. Działają podwójnie: filtrują listy i przesuwają
   prognozę – siła przesunięcia dobierana automatycznie na Twoich ocenach. */
const TASTE_LV = [['never', 'Nie pokazuj'], ['top', 'Tylko wybitne'], ['dislike', 'Nie lubię'], ['', 'Obojętne'], ['like', 'Lubię'], ['love', 'Uwielbiam']];
const TASTE_ADJ = { never: -1.4, top: -.5, dislike: -.6, like: .35, love: .6 };
const TOP_Q = 7.6;     // „wybitne”: średnia Filmweb/IMDb co najmniej tyle
const SPECIAL = {
  classic: ['Klasyka (przed 1980)', t => t.y && t.y < 1980],
  y80: ['Kino lat 80.', t => t.y >= 1980 && t.y < 1990],
  y90: ['Kino lat 90.', t => t.y >= 1990 && t.y < 2000],
  anim: ['Animacje', t => (t.g || []).includes(16)],
  animAsia: ['Animacje azjatyckie (anime)', t => (t.g || []).includes(16) && (t.c || []).slice(0, 2).some(c => REGION[c] === 'asia')],
  romcom: ['Komedie romantyczne', t => (t.g || []).includes(35) && (t.g || []).includes(10749)],
  superhero: ['Superbohaterowie (Marvel, DC)', t => feats(t).includes('hsuperhero')],
  fantasy: ['Fantasy', t => (t.g || []).includes(14) || feats(t).includes('hfantasy')],
  kids: ['Familijne i dla dzieci', t => (t.g || []).includes(10751) || (t.g || []).includes(10762)],
  docs: ['Dokumenty', t => (t.g || []).includes(99)],
  reality: ['Reality i talk-show', t => (t.g || []).some(g => [10764, 10767, 10763].includes(g))],
};
const TASTE_COUNTRIES = ['PL', 'FR', 'IT', 'GB', 'DE', 'ES', 'CZ', 'DK', 'SE', 'NO', 'BE', 'IE', 'HU', 'RO', 'IS', 'FI', 'AT', 'US', 'CA', 'AU', 'JP', 'KR', 'CN', 'IN', 'IR', 'IL', 'TR', 'RU', 'MX', 'AR', 'BR'];
const COUNTRY_ADJ = { PL: 'polskie', FR: 'francuskie', IT: 'włoskie', GB: 'brytyjskie', DE: 'niemieckie', ES: 'hiszpańskie', CZ: 'czeskie', DK: 'duńskie', SE: 'szwedzkie', NO: 'norweskie', US: 'amerykańskie', JP: 'japońskie', KR: 'koreańskie' };
function tasteLabel(k) {
  const p = k[0], v = k.slice(2);
  if (p === 's') return SPECIAL[v]?.[0] || v;
  if (p === 'r') return (REGION_NAMES[v] || v).replace(/^kino /, 'kino ');
  if (p === 'c') return 'kino ' + (COUNTRY_ADJ[v] || (COUNTRY[v] || v));
  if (p === 'g') return genreName(v) || v;
  if (p === 'h') return THEME_NAMES[v] || v;
  return k;
}
function ruleMatch(k, t) {
  const p = k[0], v = k.slice(2);
  if (p === 's') return !!SPECIAL[v]?.[1](t);
  if (p === 'r') return (t.c || []).slice(0, 2).some(c => (REGION[c] || 'other') === v);
  if (p === 'c') return (t.c || []).slice(0, 2).includes(v);
  if (p === 'g') return (t.g || []).includes(+v);
  if (p === 'h') return feats(t).includes('h' + v);
  return false;
}
function ruleHits(t) {
  if (t._rh) return t._rh;
  const out = [];
  for (const [k, lv] of Object.entries(S.local.taste || {})) if (lv && ruleMatch(k, t)) out.push([k, lv]);
  return (t._rh = out);
}
const quality = t => { const q = [t.fr, t.ir].filter(Boolean); return q.length ? q.reduce((a, b) => a + b, 0) / q.length : (t.tv > 50 ? t.tr : 0); };
function tasteAdj(t) {
  let a = 0;
  for (const [, lv] of ruleHits(t)) a += lv === 'top' ? (quality(t) >= TOP_Q ? 0 : TASTE_ADJ.top) : TASTE_ADJ[lv];
  return Math.max(-1.5, Math.min(1, a));
}
function tasteBlocked(t) {   // ukryte regułami (nie dotyczy wyszukiwania i listy „Chcę zobaczyć”)
  if (S.want && S.want.has(t.id)) return false;
  for (const [, lv] of ruleHits(t)) if (lv === 'never' || (lv === 'top' && quality(t) < TOP_Q)) return true;
  return false;
}
const adjP = (t, p) => Math.max(1, Math.min(10, p + (S.ruleK || 0) * tasteAdj(t)));
/* Startowe reguły z Twoich deklaracji (25.11) – możesz je zmienić w Profil → Mój gust */
function seedTaste() {
  if (S.local.tasteSeeded) return;
  const T0 = S.local.taste || {}, T = S.local.taste = {};
  Object.assign(T, {
    's:classic': 'top', 's:anim': 'dislike', 's:animAsia': 'never', 'r:asia': 'top',
    'r:eu': 'like', 'c:IT': 'like', 'c:CZ': 'like', 'c:FR': 'like', 'c:GB': 'like', 'c:ES': 'dislike',
    'r:pl': 'top', 'c:PL': 'like',
    'h:war': 'like', 'h:spy': 'like', 'h:terror': 'like',
    's:romcom': 'dislike', 's:fantasy': 'dislike', 's:superhero': 'never',
  }, T0);
  // dawne deklaracje (♥/✕) przechodzą do reguł
  for (const [k, v] of Object.entries(S.local.decl || {})) {
    const f = k.split('|')[1]; if (!f || !v) continue;
    const key = f[0] + ':' + f.slice(1);
    if ('rgh'.includes(f[0]) && !T[key]) T[key] = v > 0 ? 'like' : 'dislike';
  }
  S.local.decl = {};
  S.local.tasteSeeded = 1; saveLocal();
}

/* ================================================================== FILTRY */
function passes(t, f, ignoreSeen) {
  if (f.type === 'movie' && t.id[0] !== 'm') return false;
  if (f.type === 'tv' && t.id[0] !== 't') return false;
  if (f.genres.length && !f.genres.every(g => (t.g || []).includes(+g))) return false;
  if (f.moods.length) { const hv = heaviness(t); if (!f.moods.some(m => (m === 'light' && hv <= -.15) || (m === 'heavy' && hv >= .25) || (m === 'mid' && hv > -.35 && hv < .45))) return false; }
  if (f.periods.length && !f.periods.some(p => inPeriod(t, p))) return false;
  if (f.lens.length && !f.lens.some(b => inLen(t, b))) return false;
  if (f.crit.length && !f.crit.some(i => (t.ctop || []).some(([r, v]) => r === +i && v >= 7))) return false;
  if (f.critRec && !critRecommended(t)) return false;
  if (f.minCra && !(t.cra >= f.minCra)) return false;
  if (f.themes && f.themes.length) { const fs = feats(t); if (!f.themes.some(h => fs.includes('h' + h))) return false; }
  if (f.mini && !(typ(t) === 't' && (t.seasons || 0) <= 1)) return false;
  if (f.sure && !isSure(t)) return false;
  if (t.y && (t.y < f.yFrom || t.y > f.yTo)) return false;
  if (!t.y && (f.yFrom > 1920 || f.yTo < 2030)) return false;
  if (f.rtMax && t.len && t.len > f.rtMax) return false;
  const pv = t.pv || {};
  const provSel = f.onlySubs ? S.local.subs : f.provs;
  if (provSel.length && !provSel.some(p => pv[p] && 'sfa'.includes(pv[p]))) return false;
  const sel = Object.entries(f.awSel || {});
  if (sel.length && !sel.some(([code, mode]) => mode === 'win' ? (t.aw || []).includes(code) : mode === 'nom' ? (t.an || []).includes(code) : ((t.aw || []).includes(code) || (t.an || []).includes(code)))) return false;
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
  if (!ignoreSeen && !S.myRatings.has(t.id) && tasteBlocked(t)) return false;
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
function topScore(t) {   // najwyżej oceniane z uwzględnieniem liczby głosów (średnia Bayesa)
  const q = quality(t); if (!q) return 0;
  const v = t.iv || (t.tv || 0) * 8;
  return (v * q + 25000 * 6.4) / (v + 25000);
}
function sortFn(sort) {
  const P = t => S.preds.get(t.id) ?? 0;
  return {
    match: (a, b) => (P(b) + (b.pop > 30 ? .02 : 0)) - (P(a) + (a.pop > 30 ? .02 : 0)),
    fw: (a, b) => (b.fr || 0) - (a.fr || 0),
    imdb: (a, b) => (b.ir || 0) - (a.ir || 0),
    rt: (a, b) => (b.rt ?? -1) - (a.rt ?? -1),
    mc: (a, b) => (b.mc ?? -1) - (a.mc ?? -1),
    top: (a, b) => topScore(b) - topScore(a),
    cra: (a, b) => (b.cra || 0) - (a.cra || 0),
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
  $('#title').innerHTML = S.tab === 'rec'
    ? `<span class="logo" aria-label="Kinoteka"><b>KINO</b>TEKA</span><span class="logo-sub">Fryderyk’s Choice</span>`
    : titles[S.tab];
  $('#title').classList.toggle('brand', S.tab === 'rec');
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
    ['moods:light', '☀︎ Lekko', f.moods.includes('light')], ['moods:heavy', '◐ Na poważnie', f.moods.includes('heavy')],
    ['periods:new', 'Nowości', f.periods.includes('new')], ['sure', '★ Pewniaki', f.sure], ['critRec', '✎ Twoi krytycy polecają', f.critRec], ['lens:short', 'Krótko', f.lens.includes('short')],
  ];
  if (S.local.subs.length) chips.push(['subs', 'Moje serwisy', f.onlySubs]);
  chips.push(['eu', 'Europejskie', (f.regions || []).includes('eu')], ['pl', 'Polskie', f.country === 'PL'], ['aw:oscar', 'Oscary', f.awards.includes('oscar')]);
  el.innerHTML = chips.map(([k, l, on]) => `<button class="chip${on ? ' on' : ''}" data-chip="${k}">${l}</button>`).join('');
}

function card(t, mode) {
  const p = S.preds.get(t.id), mine = S.myRatings.get(t.id);
  const poster = t.p ? `style="background-image:url('${IMG}w185${t.p}')"` : '';
  const genres = (t.g || []).map(genreName).filter(Boolean).slice(0, 2).join(', ');
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
  if (!items.length) { v.innerHTML = `<div class="empty">Nic nie pasuje do tych filtrów.<br><br><button class="btn" data-reset-quick>Wyczyść filtry</button></div>`; return; }
  const filtered = activeFilterCount() > 0 || S.f.sort !== 'match';
  let html = '';
  if (!filtered) {
    const used = new Set();
    const pick = (arr, n) => { const out = []; for (const t of arr) { if (out.length >= n) break; if (!used.has(t.id)) { out.push(t); used.add(t.id); } } return out; };
    const top = pick(items.filter(t => t.p || t.bd), 1)[0];
    if (top) html += hero(top);
    const rem = reminders();
    if (rem.length) html += `<div class="section-h">Obejrzałeś?</div><div class="list">${rem.map(t => `<div class="card"><div class="poster" ${t.p ? `style="background-image:url('${IMG}w185${t.p}')"` : ''}></div><div class="info"><div class="ttl">${esc(t.t)}</div><div class="sub">Oglądałeś szczegóły niedawno – oceń, a model się poprawi</div><div class="btn-row" style="margin-top:6px"><button class="btn gold" data-remind="${t.id}" style="min-width:0;padding:8px">Oceń</button><button class="btn" data-remindx="${t.id}" style="min-width:0;padding:8px">Nie oglądałem</button></div></div></div>`).join('')}</div>`;
    html += `<button class="quick" data-quick><i>⚡︎</i><div><b>Szybkie dopasowanie</b><span>10 pytań, które najbardziej wyostrzą rekomendacje</span></div></button>`;
    html += `<button class="quick" data-like-open style="margin-top:8px"><i style="background:linear-gradient(135deg,#30d158,#64d2ff)">≈</i><div><b>Więcej takich jak…</b><span>Wybierz 1–3 ulubione filmy – znajdę podobne w tonie i stylu</span></div></button>`;
    html += `<button class="quick" data-duelskip style="margin-top:8px"><i style="background:linear-gradient(135deg,#ff9f0a,#ff375f)">⚔︎</i><div><b>Pojedynki</b><span>Który z dwóch filmów był lepszy? Rozróżnia tytuły o tej samej ocenie</span></div></button>`;
    const mineSubs = S.local.subs.length ? items.filter(t => S.local.subs.some(p => (t.pv || {})[p] && 'sfa'.includes(t.pv[p]))) : [];
    html += shelf('Na Twoich serwisach', pick(mineSubs, 12));
    html += shelf('Z Twojej listy „Chcę zobaczyć”', pick(items.filter(t => S.want.has(t.id)), 12));
    html += shelf('Twoi krytycy polecają', pick(items.filter(critRecommended).sort((a, b) => (S.preds.get(b.id) + .3 * (critAvg(b) - 7)) - (S.preds.get(a.id) + .3 * (critAvg(a) - 7))), 14));
    html += shelf('Filmy dla Ciebie', pick(items.filter(t => typ(t) === 'm'), 12));
    html += shelf('Seriale dla Ciebie', pick(items.filter(t => typ(t) === 't'), 12));
    html += shelf('Kino europejskie', pick(items.filter(t => ['eu', 'uk', 'pl'].includes(regionOf(t))), 12));
    html += shelf('Nagradzane, których nie znasz', pick(items.filter(t => (t.aw || []).length), 12));
    html += shelf('Nowości', pick(items.filter(t => t.y >= new Date().getFullYear() - 1), 12));
    html += `<div class="section-h">Wszystkie rekomendacje</div>`;
  } else {
    const top = items.find(t => t.p || t.bd);
    if (top && S.f.sort === 'match') html += hero(top).replace('Na dziś dla Ciebie', 'Najlepsze dopasowanie');
    html += `<div class="note">${items.length.toLocaleString('pl')} tytułów pasuje · <button class="linkbtn" data-reset-quick>wyczyść filtry</button></div>`;
  }
  v.innerHTML = html + list(items, 'rec');
}

function viewBrowse() {
  const base = S.q.length >= 2 ? search(S.q) : S.cat;
  const items = base.filter(t => passes(t, S.f, S.q.length >= 2)).sort(sortFn(S.local.bsort || 'top'));
  $('#view').innerHTML = `<div class="note">${items.length.toLocaleString('pl')} tytułów</div>` + (items.length ? list(items, 'browse') : `<div class="empty">Brak wyników.</div>`);
}

const MS_DEF = { sort: 'date', type: 'all', rate: 'all', genre: '', region: '', wsort: 'match' };
function mineTabs(sub) {
  return `<div class="chips" style="padding:0 0 10px">${[['rated', 'Ocenione'], ['want', 'Chcę zobaczyć'], ['critics', 'Moi krytycy'], ['hidden', 'Ukryte'], ['unmatched', 'Niedopasowane'], ['backup', 'Kopia zapasowa']]
    .map(([k, l]) => `<button class="chip${sub === k ? ' on' : ''}" data-mine="${k}">${l}</button>`).join('')}</div>`;
}
function mineControls(sub) {
  const M = S.local.ms = Object.assign({}, MS_DEF, S.local.ms || {});
  const sel = (key, opts) => `<select data-ms="${key}">${opts.map(([v, l]) => `<option value="${v}"${M[key] === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const genres = Object.entries(S.meta.genres || {}).sort((a, b) => a[1].localeCompare(b[1], 'pl'));
  const sorts = sub === 'rated'
    ? [['date', 'Ostatnio ocenione'], ['dateAsc', 'Najdawniej ocenione'], ['rDesc', 'Moja ocena: najwyższe'], ['rAsc', 'Moja ocena: najniższe'], ['yDesc', 'Rok: najnowsze'], ['yAsc', 'Rok: najstarsze'], ['title', 'Tytuł A–Z'], ['above', 'Oceniam wyżej niż widzowie'], ['below', 'Oceniam niżej niż widzowie']]
    : [['match', 'Dopasowanie do mnie'], ['fw', 'Ocena Filmweb'], ['yDesc', 'Rok: najnowsze'], ['title', 'Tytuł A–Z']];
  return `<div class="mctl">${sel(sub === 'rated' ? 'sort' : 'wsort', sorts)}
    ${sel('type', [['all', 'Filmy i seriale'], ['m', 'Filmy'], ['t', 'Seriale']])}
    ${sub === 'rated' ? sel('rate', [['all', 'Każda ocena'], ['9', '9–10'], ['7', '7–8'], ['5', '5–6'], ['1', '1–4']]) : ''}
    ${sel('genre', [['', 'Każdy gatunek'], ...genres])}
    ${sel('region', [['', 'Każdy region'], ...Object.entries(REGION_NAMES)])}</div>`;
}
function mineFilter(items, sub) {
  const M = Object.assign({}, MS_DEF, S.local.ms || {}), R = id => S.myRatings.get(id) || {};
  const band = { 9: [9, 10], 7: [7, 8], 5: [5, 6], 1: [1, 4] }[M.rate];
  items = items.filter(t => (M.type === 'all' || typ(t) === M.type) && (!M.genre || (t.g || []).includes(+M.genre)) && (!M.region || regionOf(t) === M.region)
    && (sub !== 'rated' || !band || (R(t.id).r >= band[0] && R(t.id).r <= band[1])));
  const crowd = t => R(t.id).r - (quality(t) || R(t.id).r);
  const f = {
    date: (a, b) => (R(b.id).date || '').localeCompare(R(a.id).date || ''), dateAsc: (a, b) => (R(a.id).date || '').localeCompare(R(b.id).date || ''),
    rDesc: (a, b) => R(b.id).r - R(a.id).r || (R(b.id).date || '').localeCompare(R(a.id).date || ''), rAsc: (a, b) => R(a.id).r - R(b.id).r,
    yDesc: (a, b) => (b.y || 0) - (a.y || 0), yAsc: (a, b) => (a.y || 0) - (b.y || 0), title: (a, b) => a.t.localeCompare(b.t, 'pl'),
    above: (a, b) => crowd(b) - crowd(a), below: (a, b) => crowd(a) - crowd(b),
    match: (a, b) => (S.preds.get(b.id) || 0) - (S.preds.get(a.id) || 0), fw: (a, b) => (b.fr || 0) - (a.fr || 0),
  }[sub === 'rated' ? M.sort : M.wsort];
  return items.sort(f);
}
function viewMyCritics() {
  const C = S.critics || [], sel = S.critSel;
  let html = mineTabs('critics');
  if (!C.length) { $('#view').innerHTML = html + `<div class="empty">Dopasowuję krytyków do Twoich ocen – lista pojawi się po najbliższej aktualizacji danych.</div>`; return; }
  html += `<div class="note">10 krytyków Filmwebu, których oceny najbardziej przypominają Twoje. Stuknij, żeby zobaczyć ich oceny.</div>
    <div class="list">${C.map((c, i) => `<button class="card crit${sel === i ? ' on' : ''}" data-crit="${i}" style="padding:12px 16px"><div class="info"><div class="ttl">${i + 1}. ${esc(c.name)}</div><div class="sub">${esc(c.pub || '')} · ${c.n} wspólnych filmów · zgodność ${Math.round(c.agree * 100)}% · korelacja ${fmt(c.corr, 2)}</div></div></button>`).join('')}</div>`;
  if (sel != null && C[sel]) {
    const c = C[sel], rated = [], recs = [];
    for (const t of S.cat) { const v = (t.ctop || []).find(x => x[0] === sel); if (!v) continue; (S.myRatings.has(t.id) ? rated : recs).push([t, v[1]]); }
    recs.sort((a, b) => b[1] - a[1] || (S.preds.get(b[0].id) || 0) - (S.preds.get(a[0].id) || 0));
    rated.sort((a, b) => Math.abs(S.myRatings.get(a[0].id).r - a[1]) - Math.abs(S.myRatings.get(b[0].id).r - b[1]));
    html += `<div class="section-h">${esc(c.name)} poleca – nie widziałeś <small>${recs.length}</small></div>`
      + (recs.length ? `<table class="mini">${recs.slice(0, 40).map(([t, v]) => `<tr data-id="${t.id}" class="row-link"><td>${esc(t.t)} <small style="color:var(--tx2)">${t.y || ''}</small></td><td>krytyk <b>${v}</b></td><td>dla Ciebie <b>${fmt(S.preds.get(t.id))}</b></td></tr>`).join('')}</table>` : `<div class="note">Jeszcze zbieram – przybędzie po kolejnych aktualizacjach.</div>`)
      + `<div class="section-h">Wspólne filmy <small>${rated.length}</small></div>
      <table class="mini">${rated.map(([t, v]) => { const r = S.myRatings.get(t.id).r; return `<tr data-id="${t.id}" class="row-link"><td>${esc(t.t)}</td><td>Ty <b>${r}</b></td><td class="${Math.abs(r - v) <= 1 ? 'good' : 'bad'}">krytyk <b>${v}</b></td></tr>`; }).join('')}</table>`;
  }
  $('#view').innerHTML = html;
}
function viewBackup() {
  let b = {}; try { b = JSON.parse(localStorage.getItem(BAK_KEY) || '{}'); } catch (e) { /* brak */ }
  const n = Object.keys(S.local.ratings).length;
  $('#view').innerHTML = mineTabs('backup') + `<div class="section-h">Twoje dane w aplikacji</div>
    <div class="note">Oceny z Filmwebu są bezpieczne – aplikacja pobiera je sama 3 razy dziennie. Na tym urządzeniu przechowywane są tylko: ${n} ocen nadanych w aplikacji, „Chcę zobaczyć”, ukryte tytuły, pojedynki, reguły „Mój gust” i ustawienia.<br><br>
    Uwaga: aplikacja z ekranu głównego iPhone’a i Safari mają <b>osobne</b> pamięci. Kopia pozwala przenieść dane między nimi albo na nowy telefon. Wczytanie kopii <b>łączy</b> dane – niczego nie usuwa.</div>
    ${IN_SAFARI ? `<div class="note"><b>Jesteś teraz w Safari</b> (${n} ocen z aplikacji). Zapisz tu kopię, potem otwórz Kinotekę z ikony → Moje → Kopia → Wczytaj kopię.</div>` : ''}
    <div class="btn-row"><button class="btn gold" data-bak="export">Zapisz kopię (Pliki / iCloud)</button></div>
    <div class="btn-row" style="margin-top:8px"><label class="btn" style="text-align:center">Wczytaj kopię z pliku<input type="file" accept="application/json,.json" data-bak-file hidden></label></div>
    ${fwImportHTML()}
    <div class="note" style="margin-top:14px">Automatyczna kopia dzienna: ${b.prevDay ? `stan z ${b.prevDay} – <button class="linkbtn" data-bak="restore">przywróć</button>` : 'pojawi się jutro'}.</div>`;
}
function viewMine() {
  const sub = S.mineTab || 'rated';
  if (sub === 'critics') { viewMyCritics(); return; }
  if (sub === 'backup') { viewBackup(); return; }
  let items, html = safariNote() + mineTabs(sub);
  html += (sub === 'rated' || sub === 'want') ? mineControls(sub) : '';
  if (false) html = `<div class="chips" style="padding:0 0 10px">${[['rated', 'Ocenione'], ['want', 'Chcę zobaczyć'], ['hidden', 'Ukryte'], ['unmatched', 'Niedopasowane']]
    .map(([k, l]) => `<button class="chip${sub === k ? ' on' : ''}" data-mine="${k}">${l}</button>`).join('')}</div>`;
  const tfw = toFilmweb();
  if (tfw.length && sub === 'rated') html += `<div class="section-h">Do przepisania na Filmweb <small>${tfw.length}</small></div>
    <div class="note">Oceny z aplikacji – wpisz je na Filmwebie, wtedy wejdą też do Twojego profilu tam.</div>
    <table class="mini">${tfw.map(x => `<tr><td><a href="${x.t.fw ? `https://www.filmweb.pl/${typ(x.t) === 't' ? 'serial' : 'film'}/x-${x.t.y || 0}-${x.t.fw}` : `https://www.filmweb.pl/search#/?query=${encodeURIComponent(x.t.ot || x.t.t)}`}" target="_blank" rel="noopener" style="color:var(--tint);text-decoration:none">${esc(x.t.t)}</a></td><td><b>${x.r}</b></td><td><button class="linkbtn" data-fwdone="${x.t.id}">✓ wpisane</button></td></tr>`).join('')}</table><div class="section-h">Wszystkie oceny</div>`;
  if (sub === 'rated') {
    items = mineFilter([...S.myRatings.keys()].map(id => S.byId.get(id)).filter(Boolean), 'rated');
    const avg = items.length ? items.reduce((a, t) => a + S.myRatings.get(t.id).r, 0) / items.length : 0;
    html += `<div class="note">${items.length} z ${S.myRatings.size} ocen · średnia ${fmt(avg)} · źródło: Filmweb (${esc(S.me.user)})${Object.keys(S.local.ratings).length ? ' + oceny z aplikacji' : ''}</div>`;
  } else if (sub === 'want') {
    items = mineFilter([...S.want].map(id => S.byId.get(id)).filter(Boolean), 'want');
    html += `<div class="note">${items.length} tytułów</div>`;
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

/* Zaskoczenia po seansie: czy aplikacja wyprzedza Twoje oczekiwania (prognoza vs ocena tłumu) */
function surpHTML() {
  const pct = x => Math.round(x * 100) + "%";
  const sp = Object.entries(S.local.surp || {}).filter(([id]) => S.byId.get(id) && S.myRatings.has(id));
  if (!sp.length) return '';
  const lab = { '-1': 'gorzej', 0: 'jak myślałem', 1: 'lepiej' };
  const rows = sp.map(([id, v]) => { const t = S.byId.get(id), base = t.fr || t.ir, p = (S.local.predlog || {})[id]?.[0] ?? S.preds.get(id); return { t, v, base, p, r: S.myRatings.get(id).r }; });
  const sure = rows.filter(x => x.v && x.base && x.p != null);
  const hit = sure.filter(x => Math.sign(x.p - x.base) === x.v).length;
  const c = k => rows.filter(x => x.v === k).length;
  return `<div class="section-h">Zaskoczenia po seansie</div>
    <div class="note">Lepiej niż myślałeś: <b>${c(1)}</b> · gorzej: <b>${c(-1)}</b> · bez niespodzianek: <b>${c(0)}</b>.${sure.length ? ` Przy zaskoczeniach aplikacja przewidziała kierunek (wyżej/niżej niż ocena widzów) w <b>${pct(hit / sure.length)}</b> przypadków.` : ''} Zaskoczenia mają w nauce większą wagę – pokazują to, czego nie widać po gatunku i obsadzie.</div>
    <table class="mini">${rows.slice(-10).reverse().map(x => `<tr><td>${esc(x.t.t)}</td><td>${lab[x.v]}</td><td>${x.p != null ? 'prognoza ' + fmt(x.p) : ''}</td><td>Ty ${x.r}</td></tr>`).join('')}</table>`;
}
function curveHTML(C) {
  const W = 340, H = 170, pl = 30, pr = 10, pt = 14, pb = 30;
  const vals = C.flatMap(c => [c.mae, c.crowd].filter(x => x != null));
  const lo = Math.floor(Math.min(...vals) * 4) / 4 - .1, hi = Math.ceil(Math.max(...vals) * 4) / 4 + .1;
  const x = i => pl + i * (W - pl - pr) / (C.length - 1), y = v => pt + (v - lo) / (hi - lo) * (H - pt - pb);
  const yy = v => H - pb - (y(v) - pt);
  const line = (k, cls) => `<polyline class="${cls}" fill="none" points="${C.map((c, i) => c[k] != null ? `${x(i)},${yy(c[k])}` : '').filter(Boolean).join(' ')}"/>` + C.map((c, i) => c[k] != null ? `<circle class="${cls}" cx="${x(i)}" cy="${yy(c[k])}" r="3.5"/>` : '').join('');
  const ticks = [lo + .1, (lo + hi) / 2, hi - .1].map(v => `<text x="${pl - 6}" y="${yy(v) + 4}" text-anchor="end">±${fmt(v, 1)}</text><line x1="${pl}" x2="${W - pr}" y1="${yy(v)}" y2="${yy(v)}" class="grid"/>`).join('');
  const lab = C.map((c, i) => `<text x="${x(i)}" y="${H - 10}" text-anchor="middle">${c.to.slice(5, 7)}.${c.to.slice(2, 4)}</text>`).join('');
  const first = C[0], last = C.at(-1), d = first.mae - last.mae;
  return `<div class="section-h">Czy trafia coraz lepiej</div>
  <svg class="curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Błąd prognoz w kolejnych okresach">${ticks}${line('crowd', 'c2')}${line('mae', 'c1')}${lab}</svg>
  <div class="legend"><span><i class="c1"></i>Kinoteka</span><span><i class="c2"></i>sama ocena portali</span><small>niżej = mniejszy błąd</small></div>
  <div class="note">Dla każdego okresu model uczy się tylko na ocenach sprzed niego i przewiduje te, które dałeś później. ${Math.abs(d) >= .05 ? (d > 0 ? `Błąd spadł z ±${fmt(first.mae, 2)} do <b class="good">±${fmt(last.mae, 2)}</b> – im więcej ocen, tym lepiej Cię zna.` : `Ostatnio błąd wzrósł (±${fmt(first.mae, 2)} → ±${fmt(last.mae, 2)}) – możliwe, że Twój gust się zmienia; nowe oceny szybko to wyrównają.`) : `Błąd jest stabilny (ok. ±${fmt(last.mae, 2)}).`}</div>`;
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
  if (ev.curve && ev.curve.length >= 2) html += curveHTML(ev.curve);
  html += surpHTML();
  html += `<div class="section-h">Na żywo</div>`;
  html += ev.live ? `<div class="note">Przewidywania zapisane, zanim oceniłeś tytuł (${ev.live.n}): średni błąd <b>±${fmt(ev.live.mae, 2)}</b>.</div>
    <table class="mini">${ev.livePairs.slice(-15).reverse().map(([p, r, s]) => `<tr><td>${esc(s.t?.t)}</td><td>prognoza ${fmt(p)}</td><td class="${Math.abs(p - r) <= 1 ? 'good' : 'bad'}">Ty ${r}</td></tr>`).join('')}</table>`
    : `<div class="note">Aplikacja zapisała prognozy dla ${Object.keys(S.local.predlog).length.toLocaleString('pl')} tytułów. Gdy obejrzysz coś i ocenisz (na Filmwebie albo tutaj), pojawi się tu porównanie prognozy z Twoją oceną.</div>`;
  html += `<div class="note" style="margin-top:18px">Twoje reguły i to, czego model nauczył się o Twoim guście, znajdziesz w Profil → Mój gust.</div>`;
  html += settingsHTML();
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
const dpl = d => d ? d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(2, 4) : '';
function histLine(id) {
  const h = (S.local.rhist || {})[id];
  if (!h || h.length < 2) return '';
  return `<div class="note" style="margin:8px 0 0">Historia oceny: ${h.map(([r, d]) => `<b>${r}</b>${d ? ` <small>(${dpl(d)})</small>` : ''}`).join(' → ')}</div>`;
}
function histHTML() {
  const rows = Object.entries(S.local.rhist || {}).filter(([id, h]) => h.length > 1 && S.byId.get(id))
    .sort((a, b) => (b[1].at(-1)[1] || '').localeCompare(a[1].at(-1)[1] || ''));
  return `<div class="section-h">Zmiany ocen</div>` + (rows.length
    ? `<table class="mini">${rows.slice(0, 30).map(([id, h]) => { const a = h[0][0], b = h.at(-1)[0]; return `<tr class="row-link" data-id="${id}"><td>${esc(S.byId.get(id).t)}</td><td>${h.map(x => x[0]).join(' → ')}</td><td class="${b > a ? 'good' : 'bad'}">${b > a ? '▲' : '▼'} ${dpl(h.at(-1)[1])}</td></tr>`; }).join('')}</table>`
    : `<div class="note">Gdy zmienisz ocenę (tutaj albo na Filmwebie), poprzednia zostanie zapisana i zobaczysz tu, jak zmieniało się Twoje zdanie.</div>`);
}
async function openDetail(id) {
  const t = S.byId.get(id); if (!t) return;
  if (!S.myRatings.has(id)) { S.local.opened = S.local.opened || {}; if (!S.local.opened[id]) { S.local.opened[id] = new Date().toISOString(); saveLocal(); } }
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
    ${(t.g || []).map(genreName).filter(Boolean).join(', ')}<br>${(t.c || []).map(c => COUNTRY[c] || c).join(', ')}<br>${heaviness(t) < -.15 ? '☀︎ lekki' : heaviness(t) > .25 ? '◐ poważny' : '◑ wyważony'}${feats(t).filter(f => f[0] === 'h').slice(0, 3).map(f => ' · ' + THEME_NAMES[f.slice(1)]).join('')}</div></div></div>
  <div class="d-scores">
    ${mine ? `<div class="d-sc me"><span>Twoja ocena</span><b>${mine.r}</b></div>` : p != null ? `<div class="d-sc me"><span>Dla Ciebie</span><b>${fmt(p)}</b></div>` : ''}
    ${t.fr ? `<div class="d-sc"><span>Filmweb</span><b>${fmt(t.fr)}</b><small>${kfmt(t.fn || 0)}</small></div>` : ''}
    ${t.ir ? `<div class="d-sc"><span>IMDb</span><b>${fmt(t.ir)}</b><small>${kfmt(t.iv || 0)}</small></div>` : ''}
    ${t.rt != null ? `<div class="d-sc"><span>Rotten T.</span><b>${t.rt}%</b></div>` : ''}
    ${t.mc != null ? `<div class="d-sc"><span>Metacritic</span><b>${t.mc}</b></div>` : ''}
    ${t.tv ? `<div class="d-sc"><span>TMDB</span><b>${fmt(t.tr)}</b><small>${kfmt(t.tv)}</small></div>` : ''}
  </div>
  ${(t.ctop || t.cra) ? `<div class="d-sec"><h3>Krytycy</h3><p>${t.cra ? `Średnia krytyków Filmwebu: <b>${fmt(t.cra)}</b> (${t.crn})<br>` : ''}${(t.ctop || []).map(([i, v]) => S.critics[i] ? `${esc(S.critics[i].name)} <b>${v}</b>` : '').filter(Boolean).join(' · ')}${t.ctop ? `<br><small style="color:var(--tx2)">Twoi krytycy – oceniają najbardziej podobnie do Ciebie</small>` : ''}</p></div>` : ''}
  ${reasons.length ? `<div class="d-sec"><h3>Dlaczego dla Ciebie</h3><ul class="reasons">${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
  <div class="d-sec"><h3>Opis</h3><p id="ov">…</p></div>
  ${t.d?.length ? `<div class="d-sec"><h3>${t.id[0] === 't' ? 'Twórcy' : 'Reżyseria'}</h3><p>${esc(t.d.join(', '))}</p></div>` : ''}
  ${t.a?.length ? `<div class="d-sec"><h3>Obsada</h3><p>${esc(t.a.join(', '))}</p></div>` : ''}
  ${awards.length || t.awt ? `<div class="d-sec"><h3>Nagrody</h3><p>${esc(awards.join(' · '))}${t.awl?.length ? `<br><small style="color:var(--tx2)">${esc(t.awl.join(' · '))}</small>` : ''}${t.awt ? `<br><small style="color:var(--tx2)">${esc(t.awt)}</small>` : ''}</p></div>` : ''}
  <div class="d-sec"><h3>Gdzie obejrzeć w Polsce</h3>${pv.length ? `<div class="prov-row">${pv.map(([pid, c]) => { const pi = provInfo(pid) || [pid]; return `<a class="prov" href="${tmdbUrl}/watch?locale=PL" target="_blank" rel="noopener">${pi[1] ? `<img src="${IMG}w92${pi[1]}">` : ''}<span>${esc(pi[0])}<br><em>${kind[c]}</em></span></a>`; }).join('')}</div>` : '<p style="color:var(--tx2)">Brak w serwisach VOD w Polsce.</p>'}</div>
  <div class="d-sec"><h3>${mine ? 'Zmień ocenę' : 'Obejrzałem – moja ocena'}</h3>
    <div class="stars">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<button data-rate="${n}" class="${mine?.r === n ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${mine ? `<div class="surp"><span>Lepiej czy gorzej, niż się spodziewałeś?</span><div class="seg">${[['-1', 'Gorzej'], ['0', 'Tak jak myślałem'], ['1', 'Lepiej']].map(([v, l]) => `<button data-surp="${v}" class="${String((S.local.surp || {})[id]) === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>` : ''}
    ${aspectsHTML(id)}
    ${histLine(id)}${safariNote()}
    <div class="note" style="margin:6px 0 0">Ocena trafia do modelu od razu. Na Filmweb wystaw ją osobno – aplikacja nie może zapisywać na Twoim koncie.</div></div>
  <div class="btn-row">
    <button class="btn${S.want.has(id) ? ' on' : ''}" data-want>${S.want.has(id) ? '✓ Chcę zobaczyć' : '+ Chcę zobaczyć'}</button>
    <button class="btn" data-hide>${S.local.hidden[id] ? 'Przywróć' : 'Nie dla mnie'}</button>
  </div>
  <div class="btn-row" style="margin-top:8px"><button class="btn" data-like-from="${id}">≈ Więcej takich jak ten</button></div>
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
  body.innerHTML = `<div class="grab"></div><button class="x" data-close aria-label="Zamknij">✕</button><h2 style="margin:0 0 6px;font:700 28px var(--sfd)">Filtry</h2>
  <div class="f-group"><h3>Sortuj</h3><div class="row2"><select data-f="${S.tab === 'browse' ? 'bsort' : 'sort'}">
    ${[...(S.tab === 'browse' ? [['top', 'Najwyżej oceniane (oceny + liczba głosów)']] : []), ['match', 'Dopasowanie do mnie'], ['fw', 'Ocena Filmweb'], ['imdb', 'Ocena IMDb'], ['rt', 'Rotten Tomatoes'], ['mc', 'Metacritic'], ['cra', 'Krytycy Filmwebu'], ['new', 'Najnowsze'], ['pop', 'Popularne teraz'], ['votes', 'Liczba głosów']]
      .map(([v, l]) => `<option value="${v}"${(S.tab === 'browse' ? (S.local.bsort || 'top') : f.sort) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div></div>
  <div class="f-group"><h3>Rodzaj</h3><div class="f-chips">${[['all', 'Wszystko'], ['movie', 'Filmy'], ['tv', 'Seriale']].map(([v, l]) => `<button class="chip${f.type === v ? ' on' : ''}" data-set="type:${v}">${l}</button>`).join('')}
    <button class="chip${f.mini ? ' on' : ''}" data-toggle="mini">Miniserial</button></div></div>
  <div class="note" style="margin:0 0 4px">Wszystkie filtry działają razem. W każdej grupie możesz zaznaczyć kilka opcji.</div>
  <div class="f-group"><h3>Nastrój</h3><div class="f-chips">${[['light', '☀︎ Lekko'], ['mid', '◑ Pośrodku'], ['heavy', '◐ Ciężko']].map(([v, l]) => `<button class="chip${f.moods.includes(v) ? ' on' : ''}" data-arr="moods:${v}">${l}</button>`).join('')}</div></div>
  <div class="f-group"><h3>Okres</h3><div class="f-chips">${Object.entries(PERIODS).filter(([v]) => v !== 'any').map(([v, [l]]) => `<button class="chip${f.periods.includes(v) ? ' on' : ''}" data-arr="periods:${v}">${l}</button>`).join('')}</div></div>
  <div class="f-group"><h3>Czas trwania</h3><div class="f-chips">${Object.entries(LENB).filter(([v]) => v !== 'any').map(([v, l]) => `<button class="chip${f.lens.includes(v) ? ' on' : ''}" data-arr="lens:${v}">${l}</button>`).join('')}</div>
    <div class="note" style="margin:6px 0 0">Filmy: krótko ≤ 100 min, średnio 100–130, długo > 130 · Seriale (odcinek): ≤ 30, 30–55, > 55 min</div></div>
  <div class="f-group"><h3>Tematy (dowolny z zaznaczonych)</h3><div class="f-chips">${THEMES.map(([k, l]) => `<button class="chip${(f.themes || []).includes(k) ? ' on' : ''}" data-arr="themes:${k}">${esc(l)}</button>`).join('')}</div></div>
  <div class="f-group"><h3>Głosy krytyków</h3>
    ${(S.critics || []).length ? `<div class="f-chips" style="margin-bottom:8px"><button class="chip${f.critRec ? ' on' : ''}" data-toggle="critRec">✎ Polecane przez moich krytyków</button></div>
    <div class="note" style="margin:0 0 8px">Albo wybierz krytyków – pokażę filmy, które ocenił na 7+ choć jeden z zaznaczonych:</div>
    <div class="f-chips">${S.critics.map((c, i) => `<button class="chip${f.crit.includes(String(i)) ? ' on' : ''}" data-arr="crit:${i}">${esc(c.name)} · ${Math.round(c.agree * 100)}%</button>`).join('')}</div>`
    : `<div class="note" style="margin:0">Dopasowuję krytyków do Twoich ocen – lista pojawi się po kolejnych aktualizacjach danych.</div>`}
    <div style="margin-top:10px">${'' }</div></div>
  ${rng('minCra', 0, 9, .1, 'Min. ocena krytyków Filmwebu')}
  <div class="f-group"><h3>Dopasowanie</h3><div class="f-chips"><button class="chip${f.sure ? ' on' : ''}" data-toggle="sure">★ Tylko pewniaki – maksymalnie dopasowane</button></div></div>
  <div class="f-group"><h3>Gdzie obejrzeć (abonament / za darmo)</h3><div class="f-chips">
    ${S.local.subs.length ? `<button class="chip${f.onlySubs ? ' on' : ''}" data-toggle="onlySubs">★ Moje serwisy</button>` : ''}
    ${provs.map(([id, p]) => `<button class="chip${f.provs.includes(id) ? ' on' : ''}" data-arr="provs:${id}">${p[1] ? `<img src="${IMG}w45${p[1]}">` : ''}${esc(p[0])}</button>`).join('')}</div></div>
  <div class="f-group"><h3>Festiwale i nagrody</h3>
    <div class="note" style="margin:0 0 8px">Stuknij: <b>wygrana</b> → <b>nominacja</b> (bez wygranej) → <b>wygrana lub nominacja</b> → wyłącz. Kilka zaznaczeń = dowolne z nich.</div>
    <div class="f-chips">${FESTIVALS.flat().map(k => { const m = (f.awSel || {})[k]; const lab = { win: ' · wygrana', nom: ' · nominacja', any: ' · nominacja/wygrana' }[m] || ''; return `<button class="chip${m ? ' on' : ''}" data-aw="${k}">${esc(AWARDS[k])}${lab}</button>`; }).join('')}</div></div>
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
    body.innerHTML = `<div class="grab"></div><button class="x" data-close aria-label="Zamknij">✕</button><h2 style="font:700 28px var(--sfd)">Gotowe</h2>
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

/* ------------------------------------------------------------------ odrzucenia z powodem */
const REASONS = [['heavy', 'Za ciężki na mój gust'], ['light', 'Za lekki / za błahy'], ['theme', 'Nie ten temat'], ['creator', 'Nie lubię twórcy lub aktora'],
  ['genre', 'Nie lubię tego gatunku'], ['seen', 'Już widziałem – ocenię'], ['later', 'Nie teraz (tylko ukryj)']];
function openReasons(id) {
  const t = S.byId.get(id), body = $('#sheet .sheet-body');
  body.dataset.id = id;
  body.innerHTML = `<div class="grab"></div><button class="x" data-close aria-label="Zamknij">✕</button>
    <h2 style="font:700 24px var(--sfd);margin:0 0 4px">Dlaczego nie?</h2><div class="note">${esc(t.t)} – Twoja odpowiedź mówi modelowi, czego dokładnie unikać.</div>
    <div class="list">${REASONS.map(([k, l]) => `<button class="card" data-reason="${k}" style="padding:15px 16px">${l}</button>`).join('')}</div>
    <div class="section-h">Albo nie pokazuj więcej takich</div>
    <div class="note">Ustawia regułę w „Mój gust” i ukrywa ten tytuł.</div>
    <div class="f-chips">${rejectRules(t).map(([k, lv, l]) => `<button class="chip" data-rrule="${k}|${lv}">${esc(l)}</button>`).join('')}</div>`;
  $('#sheet').hidden = false;
}
function rejectRules(t) {
  const out = [];
  const asia = (t.c || []).slice(0, 2).some(c => REGION[c] === 'asia');
  if ((t.g || []).includes(16) && asia) out.push(['s:animAsia', 'never', 'Bez azjatyckich animacji']);
  if ((t.g || []).includes(16)) out.push(['s:anim', 'dislike', 'Nie lubię animacji']);
  if (t.y && t.y < 1980) out.push(['s:classic', 'top', 'Klasyka tylko wybitna'], ['s:classic', 'never', 'Bez klasyki']);
  else if (t.y && t.y < 2000) out.push([`s:y${String(t.y).slice(2, 3)}0`, 'top', `Lata ${String(t.y).slice(2, 3)}0. tylko wybitne`]);
  const c = (t.c || [])[0];
  if (c) { out.push(['c:' + c, 'dislike', `Nie lubię: ${tasteLabel('c:' + c)}`]); const r = REGION[c]; if (r && r !== 'eu' && r !== 'pl') out.push(['r:' + r, 'top', `${REGION_NAMES[r]} – tylko wybitne`]); }
  for (const g of (t.g || []).slice(0, 3)) if (genreName(g)) out.push(['g:' + g, 'dislike', `Nie lubię: ${genreName(g).toLowerCase()}`]);
  for (const sp of ['romcom', 'superhero', 'fantasy', 'kids']) if (SPECIAL[sp][1](t)) out.push(['s:' + sp, 'never', `Bez: ${SPECIAL[sp][0].toLowerCase()}`]);
  return out.filter(x => x[0] !== 's:y00' && x[0] !== 's:y70' && x[0] !== 's:y60');
}
function rejectWith(id, reason) {
  if (reason === 'seen') { openDetail(id); return; }
  S.local.hidden[id] = 1;
  S.local.rejects = S.local.rejects || {};
  S.local.rejects[id] = reason;
  saveLocal(); closeSheet(); buildModel(); render();
}
/* priorytety z powodów odrzuceń: konkretne cechy dostają ujemne „pseudo-oceny” */
function rejectPriors(out) {
  const rj = S.local.rejects || {};
  for (const [id, why] of Object.entries(rj)) {
    const t = S.byId.get(id); if (!t) continue;
    const ty = typ(t), fs = feats(t);
    const push = (f, v, n) => { const k = ty + '|' + f, cur = out.get(k) || [0, 0]; out.set(k, [cur[0] + v * n, cur[1] + n]); };
    if (why === 'theme') fs.filter(f => f[0] === 'h').forEach(f => push(f, -.5, 1));
    if (why === 'creator') { (t.d || []).forEach(d => push('d' + d, -.9, 1.5)); (t.a || []).slice(0, 2).forEach(a => push('a' + a, -.5, 1)); }
    if (why === 'genre') (t.g || []).forEach(g => push('g' + g, -.5, 1));
  }
}

/* ------------------------------------------------------------------ pojedynki: który lepszy? */
function duelPair() {
  const R = [...S.myRatings.entries()].map(([id, r]) => ({ t: S.byId.get(id), r: r.r, id })).filter(x => x.t && (x.t.p || x.t.bd));
  const done = new Set((S.local.duels || []).map(d => [d[0], d[1]].sort().join('|')));
  for (let k = 0; k < 200; k++) {
    const a = R[Math.floor(Math.random() * R.length)], b = R[Math.floor(Math.random() * R.length)];
    if (!a || !b || a.id === b.id || typ(a.t) !== typ(b.t) || Math.abs(a.r - b.r) > 1) continue;
    if (done.has([a.id, b.id].sort().join('|'))) continue;
    return [a, b];
  }
  return null;
}
function openDuel() {
  S.duel = S.duel || { n: 0 };
  const pair = duelPair(), body = $('#sheet .sheet-body');
  body.dataset.id = '';
  if (!pair || S.duel.n >= 10) {
    body.innerHTML = `<div class="grab"></div><button class="x" data-close aria-label="Zamknij">✕</button><h2 style="font:700 28px var(--sfd)">Dzięki!</h2>
      <p class="note">${S.duel.n} pojedynków zapisanych. Model rozróżnia teraz lepiej tytuły, które oceniłeś tak samo.</p><div class="btn-row"><button class="btn gold" data-duelskip>Jeszcze 10</button><button class="btn" data-close>Zamknij</button></div>`;
    if (S.duel.n) { buildModel(); render(); }
    S.duel = null; $('#sheet').hidden = false; return;
  }
  S.duel.pair = pair;
  const side = (x, k) => `<button class="duel" data-duel="${k}"><div class="poster" style="background-image:url('${IMG}w342${x.t.p}')"></div><div class="t1">${esc(x.t.t)}</div><div class="t2">${x.t.y || ''} · Twoja ocena ${x.r}</div></button>`;
  body.innerHTML = `<div class="grab"></div><button class="x" data-close aria-label="Zamknij">✕</button>
    <div class="eyebrow">Pojedynek ${S.duel.n + 1} z 10</div><h2 style="font:700 26px var(--sfd);margin:4px 0 14px">Który był lepszy?</h2>
    <div class="duels">${side(pair[0], 'a')}${side(pair[1], 'b')}</div>
    <div class="btn-row" style="margin-top:14px"><button class="btn" data-duel="tie">Tak samo dobre</button><button class="btn" data-duelskip>Pomiń</button></div>`;
  $('#sheet').hidden = false;
}
function duelAnswer(k) {
  const [a, b] = S.duel.pair;
  S.local.duels = S.local.duels || [];
  if (k === 'a') S.local.duels.push([a.id, b.id]); else if (k === 'b') S.local.duels.push([b.id, a.id]); else S.local.duels.push([a.id, b.id, 'tie']);
  S.duel.n++; saveLocal(); openDuel();
}
/* korekty ocen z pojedynków: zwycięzca +, przegrany − (maks. ±0,75) */
function duelAdjust() {
  const adj = {};
  for (const [w, l, tie] of S.local.duels || []) { if (tie) continue; adj[w] = (adj[w] || 0) + .25; adj[l] = (adj[l] || 0) - .25; }
  for (const k in adj) adj[k] = Math.max(-.75, Math.min(.75, adj[k]));
  return adj;
}

/* ------------------------------------------------------------------ przypomnienia o ocenie */
function reminders() {
  const op = S.local.opened || {}, skip = S.local.remindSkip || {}, now = Date.now();
  return Object.entries(op).filter(([id, d]) => !S.myRatings.has(id) && !skip[id] && !S.local.hidden[id] && S.byId.get(id) &&
    now - Date.parse(d) > 18 * 3600e3 && now - Date.parse(d) < 10 * 86400e3).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 3).map(([id]) => S.byId.get(id));
}
function toFilmweb() {   // oceny wystawione w aplikacji, których jeszcze nie ma na Filmwebie
  const fwIds = new Set((S.me.ratings || []).map(r => r.id));
  return Object.entries(S.local.ratings).filter(([id]) => !fwIds.has(id) && !(S.local.fwDone || {})[id] && S.byId.get(id)).map(([id, r]) => ({ t: S.byId.get(id), r: r.r }));
}

/* ------------------------------------------------------------------ deklaracje gustu */
const DECL_GENRES = ['18', '35', '80', '53', '36', '10752', '878', '9648', '10749', '99', '16', '27', '14', '28', '12', '10765', '10759', '10768'];
function declHTML() {
  const T = Object.entries(S.local.taste || {}).filter(([, v]) => v);
  const lvName = Object.fromEntries(TASTE_LV);
  return `<div class="section-h">Mój gust – Twoje reguły</div>
  <div class="note">${T.length} reguł. ${S.ruleK ? `Siła dobrana na Twoich ocenach: ×${fmt(S.ruleK, 2)}${S.ruleGain > .005 ? ` – poprawiają trafność o <b>${Math.round(S.ruleGain * 100)}%</b>` : ''}.` : ''}</div>
  <div class="f-chips">${T.map(([k, v]) => `<span class="chip ${['never', 'dislike', 'top'].includes(v) ? 'decl neg' : 'decl on'}">${esc(tasteLabel(k))} · ${esc(lvName[v])}</span>`).join('')}</div>
  <button class="btn" data-taste-open style="margin-top:12px">Zmień mój gust</button>`;
}
function declHTML_old() {
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

/* ------------------------------------------------------------------ edytor „Mój gust” */
function openTaste() {
  const T = S.local.taste || {}, body = $('#sheet .sheet-body');
  body.dataset.id = '';
  const row = (k) => `<div class="trow"><span>${esc(tasteLabel(k))}</span><div class="tseg">${TASTE_LV.map(([lv, l]) => `<button class="${(T[k] || '') === lv ? 'on' : ''} lv-${lv || 'zero'}" data-taste="${k}|${lv}" title="${l}">${{ never: '⊘', top: '★', dislike: '−', '': '·', like: '+', love: '♥' }[lv]}</button>`).join('')}</div></div>`;
  const genres = Object.keys(S.meta.genres || {}).filter(g => ![16, 10751, 10762, 10764, 10767, 10763, 99].includes(+g)).sort((a, b) => genreName(a).localeCompare(genreName(b), 'pl'));
  body.innerHTML = `<div class="grab"></div><button class="x" data-close aria-label="Zamknij">✕</button>
  <h2 style="margin:0 0 6px;font:700 28px var(--sfd)">Mój gust</h2>
  <div class="note">⊘ nie pokazuj · ★ tylko wybitne (Filmweb/IMDb ≥ ${fmt(TOP_Q)}) · − nie lubię · · obojętne · + lubię · ♥ uwielbiam.<br>Reguły od razu ukrywają lub podbijają tytuły, a ich siłę model sprawdza na Twoich ocenach.</div>
  <div class="f-group"><h3>Najważniejsze</h3>${Object.keys(SPECIAL).map(k => row('s:' + k)).join('')}</div>
  <div class="f-group"><h3>Regiony</h3>${Object.keys(REGION_NAMES).filter(k => k !== 'other').map(k => row('r:' + k)).join('')}</div>
  <div class="f-group"><h3>Kraje</h3>${TASTE_COUNTRIES.map(c => row('c:' + c)).join('')}</div>
  <div class="f-group"><h3>Tematy</h3>${THEMES.map(([k]) => row('h:' + k)).join('')}</div>
  <div class="f-group"><h3>Gatunki</h3>${genres.map(g => row('g:' + g)).join('')}</div>`;
  $('#sheet').hidden = false;
}
function setTaste(k, lv) {
  const T = S.local.taste = S.local.taste || {};
  if (lv) T[k] = lv; else delete T[k];
  for (const t of S.cat) t._rh = null;
  saveLocal(); clearTimeout(S._tt); S._tt = setTimeout(() => { buildModel(); if ($('#sheet').hidden) render(); }, 700);
}

/* ------------------------------------------------------------------ kopia zapasowa */
const BAK_KEY = 'kinoteka.v1.bak';
function backupDaily() {   // raz dziennie zachowuje poprzedni stan – ochrona przed przypadkowym nadpisaniem
  try {
    const cur = localStorage.getItem(LS_KEY); if (!cur) return;
    const b = JSON.parse(localStorage.getItem(BAK_KEY) || '{}');
    if (b.day !== today()) localStorage.setItem(BAK_KEY, JSON.stringify({ day: today(), prev: b.data || null, prevDay: b.day || null, data: cur }));
  } catch (e) { /* brak miejsca */ }
}
function exportBackup() {
  const data = JSON.stringify({ app: 'kinoteka', v: 1, date: new Date().toISOString(), local: S.local }, null, 1);
  const name = `kinoteka-kopia-${today()}.json`;
  const file = new File([data], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: 'Kinoteka – kopia' }).catch(() => {}); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
}
/* Łączy dwie wersje danych (np. Safari + ikona na ekranie głównym) – nic nie ginie */
function mergeLocal(cur, L) {
  const out = JSON.parse(JSON.stringify(cur));
  const R = out.ratings = out.ratings || {};
  for (const [id, r] of Object.entries(L.ratings || {})) if (!R[id] || (r.date || '') > (R[id].date || '')) R[id] = r;
  const H = out.rhist = out.rhist || {};
  for (const [id, h] of Object.entries(L.rhist || {})) {
    const seen = new Set((H[id] || []).map(x => x.join('|')));
    H[id] = [...(H[id] || []), ...h.filter(x => !seen.has(x.join('|')))].sort((a, b) => (a[1] || '').localeCompare(b[1] || ''));
  }
  for (const [k, v] of Object.entries(L)) {
    if (k === 'ratings' || k === 'rhist' || k === 'filters' || k === 'tune') continue;
    if (Array.isArray(v)) out[k] = [...new Set([...(out[k] || []), ...v])];
    else if (v && typeof v === 'object') out[k] = Object.assign({}, v, out[k] || {});
    else if (out[k] == null) out[k] = v;
  }
  return out;
}
const IN_SAFARI = /iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
const safariNote = () => IN_SAFARI ? `<div class="warn">Otwarte w Safari – oceny zapisane tutaj <b>nie trafią</b> do Kinoteki z ikony na ekranie głównym (iPhone trzyma ich dane osobno). Oceniaj w aplikacji z ikony albo przenieś dane: Moje → Kopia.</div>` : '';
/* Zakładka do Safari: uruchomiona na filmweb.pl (zalogowany) pobiera WSZYSTKIE Twoje oceny do pliku */
const FW_BOOKMARKLET = "javascript:(async()=>{const U=" + (2570815) + ",B='/api/v1',out=[];const d=document.createElement('div');d.style.cssText='position:fixed;z-index:2147483647;top:12px;left:12px;right:12px;padding:16px;background:#111;color:#fff;font:15px -apple-system,sans-serif;border-radius:14px;box-shadow:0 8px 30px #0008';document.body.appendChild(d);const L=m=>d.firstChild?d.firstChild.textContent=m:d.append(m);if(!/filmweb\\.pl$/.test(location.hostname)){L('Otwórz filmweb.pl (zalogowany) i uruchom zakładkę jeszcze raz.');return}L('Kinoteka: pobieram listę ocen…');const J=async u=>{const r=await fetch(B+u,{credentials:'include',headers:{'x-locale':'pl_PL'}});if(!r.ok)throw r.status;return r.json()};for(const typ of['film','serial']){const ids=new Map();let tot=0;const P=[p=>'/users/'+U+'/votes/'+typ+(p>1?'?page='+p:''),p=>'/logged/votes/'+typ+'?page='+p,p=>'/logged/vote/'+typ+'?page='+p,p=>'/users/'+U+'/votes/'+typ+'?page='+p+'&size=100'];for(const pat of P){try{for(let p=1;p<80;p++){const j=await J(pat(p));const a=Array.isArray(j)?j:(j.votes||j.content||[]);tot=j.totalCount||tot;let n=0;for(const v of a){const id=(v.id&&v.id.id)||v.entity||v.entityId||(Array.isArray(v)?v[0]:null);if(id&&!ids.has(id)){ids.set(id,v.timestamp||v.date||(Array.isArray(v)?v[1]:null));n++}}L(typ+': znaleziono '+ids.size+(tot?' z '+tot:''));if(!n)break}}catch(e){}if(tot&&ids.size>=tot)break}const list=[...ids];let i=0,k=0;await Promise.all(Array.from({length:6},async()=>{while(i<list.length){const[id,ts]=list[i++];try{const v=await J('/users/'+U+'/votes/'+typ+'/'+id);if(v.rate)out.push({typ,fw:String(id),r:v.rate,ts:ts||v.timestamp||null,fav:!!(v.favorite||v.favourite)})}catch(e){}L(typ+': oceny '+(++k)+'/'+list.length)}}))}const nf=out.filter(x=>x.typ=='film').length,ns=out.length-nf,txt=JSON.stringify({kind:'filmweb-votes',user:U,date:new Date().toISOString(),votes:out});const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([txt],{type:'application/json'}));a.download='filmweb-oceny.json';a.textContent='Zapisz plik ('+nf+' filmów, '+ns+' seriali)';a.style.cssText='display:block;margin-top:12px;padding:12px;background:#0a84ff;color:#fff;border-radius:10px;text-align:center;font-weight:600;text-decoration:none';d.firstChild.textContent='Gotowe: '+out.length+' ocen.';d.appendChild(a);try{await navigator.clipboard.writeText(txt)}catch(e){}})();";
function fwImportHTML() {
  const n = (S.local.fwImport || []).length, used = S._fwUsed || 0;
  return `<div class="section-h">Pełny import ocen z Filmwebu</div>
  <div class="note">Bez logowania Filmweb oddaje tylko ~100 najnowszych ocen, a masz ich znacznie więcej. Ta zakładka pobierze wszystkie – na Twoim koncie, bez podawania mi hasła.</div>
  <ol class="steps">
    <li><button class="btn gold" data-fwbm style="min-width:0;padding:8px 12px">Skopiuj kod zakładki</button></li>
    <li>W Safari dodaj dowolną stronę do Zakładek (□↑ → Dodaj zakładkę), nazwij ją „Kinoteka import”.</li>
    <li>Zakładki → Edytuj → ta zakładka → w polu adresu usuń wszystko i wklej skopiowany kod.</li>
    <li>Otwórz <b>filmweb.pl</b> w Safari, zaloguj się, potem stuknij pasek adresu → Zakładki → „Kinoteka import”.</li>
    <li>Po chwili pojawi się „Zapisz plik” – zapisz w Plikach, potem tutaj: „Wczytaj kopię z pliku” i wybierz <b>filmweb-oceny.json</b>. Najlepiej wyślij mi go też w czacie – wtedy dopasuję wszystkie tytuły, także spoza katalogu.</li>
  </ol>
  ${n ? `<div class="note">Zaimportowano ${n} ocen z Filmwebu · w nauce: ${used}.</div>` : ''}`;
}
function applyFwImport() {   // oceny z pliku zakładki → oceny w modelu (dopasowanie po identyfikatorze Filmwebu)
  const V = S.local.fwImport; S._fwUsed = 0; if (!V || !V.length) return;
  if (!S._fwIdx) { S._fwIdx = new Map(); for (const t of S.cat) if (t.fw) S._fwIdx.set(typ(t) + t.fw, t.id); }
  const have = new Set((S.me.ratings || []).map(r => (r.tv ? 't' : 'm') + r.fw));
  for (const v of V) {
    const k = (v.typ === 'serial' ? 't' : 'm') + v.fw, id = S._fwIdx.get(k);
    if (!id || have.has(k) || S.myRatings.has(id)) continue;
    S.myRatings.set(id, { r: v.r, date: v.ts ? new Date(v.ts).toISOString().slice(0, 10) : '2015-01-01', src: 'fw' }); S._fwUsed++;
  }
}
function importBackup(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const j = JSON.parse(rd.result);
      if (j.kind === 'filmweb-votes') {
        const old = new Set((S.local.fwImport || []).map(v => v.typ + v.fw));
        S.local.fwImport = [...(S.local.fwImport || []).filter(v => !j.votes.some(w => w.typ === v.typ && w.fw === v.fw)), ...j.votes];
        saveLocal(); mergeRatings(); buildModel(); render();
        alert(`Wczytano ${j.votes.length} ocen z Filmwebu (nowych: ${j.votes.filter(v => !old.has(v.typ + v.fw)).length}). Do nauki weszło ${S._fwUsed}.${j.votes.length - S._fwUsed > 0 ? ` Pozostałych nie ma jeszcze w katalogu albo już je znam – wyślij mi ten plik w czacie, a dopasuję wszystkie.` : ''}`);
        return;
      }
      const L = j.local || j;
      if (!L || typeof L !== 'object' || !('ratings' in L)) throw new Error('format');
      const cur = S.local, newR = Object.keys(L.ratings || {}).filter(id => !cur.ratings[id] || (L.ratings[id].date || '') > (cur.ratings[id].date || '')).length;
      if (!confirm(`Połączyć kopię z ${String(j.date || '').slice(0, 10) || 'pliku'} z danymi w aplikacji?\n\nNowe lub nowsze oceny: ${newR}. Nic z obecnych danych nie zostanie usunięte.`)) return;
      localStorage.setItem(LS_KEY, JSON.stringify(mergeLocal(cur, L))); location.reload();
    } catch (e) { alert('To nie jest plik kopii Kinoteki.'); }
  };
  rd.readAsText(file);
}
function restoreYesterday() {
  try {
    const b = JSON.parse(localStorage.getItem(BAK_KEY) || '{}');
    if (!b.prev) { alert('Brak wcześniejszej kopii.'); return; }
    if (!confirm(`Przywrócić stan z ${b.prevDay}?`)) return;
    localStorage.setItem(LS_KEY, b.prev); location.reload();
  } catch (e) { /* brak */ }
}

/* ------------------------------------------------------------------ zdarzenia */
function setRating(id, r) {
  const prev = S.myRatings.get(id);
  if (prev && !(S.local.rhist || {})[id]) histPush(id, prev.r, prev.date, prev.src);
  histPush(id, r, today(), 'app');
  S.local.ratings[id] = { r, date: today() };
  delete S.local.hidden[id];
  saveLocal(); mergeRatings(); buildModel();
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-stat],[data-asp],[data-like-open],[data-like-from],[data-likeadd],[data-likex],[data-fwbm],[data-prof],[data-taste],[data-taste-open],[data-rrule],[data-crit],[data-bak],.row-link,[data-surp],[data-aw],[data-reason],[data-duel],[data-duelskip],[data-remind],[data-remindx],[data-fwdone],[data-reset-quick],[data-quick],[data-qrate],[data-qact],[data-decl],[data-declpart],[data-id],[data-tab],[data-chip],[data-more],[data-mine],[data-sub],[data-rate],[data-want],[data-hide],[data-set],[data-arr],[data-toggle],[data-reset],[data-close],.sheet-bg,#filterBtn');
  if (!el) return;
  if (el.classList.contains('sheet-bg') || el.dataset.close != null) { closeSheet(); render(); return; }
  if (el.dataset.stat) { S.statType = el.dataset.stat; render(); return; }
  if (el.dataset.asp) {
    const id = $('#sheet .sheet-body').dataset.id, A = S.local.aspects = S.local.aspects || {}, cur = new Set(A[id] || []);
    cur.has(el.dataset.asp) ? cur.delete(el.dataset.asp) : cur.add(el.dataset.asp);
    if (cur.size) A[id] = [...cur]; else delete A[id];
    saveLocal(); el.classList.toggle('on'); clearTimeout(S._aspT); S._aspT = setTimeout(() => { buildModel(); }, 600); return;
  }
  if (el.dataset.likeOpen != null) { S.likeQ = ''; openLike(); return; }
  if (el.dataset.likeFrom) { S.like = []; S.likeQ = ''; openLike(el.dataset.likeFrom); return; }
  if (el.dataset.likeadd) { S.likeQ = ''; openLike(el.dataset.likeadd); return; }
  if (el.dataset.likex) { S.like = (S.like || []).filter(x => x !== el.dataset.likex); renderLike(); return; }
  if (el.dataset.fwbm != null) {
    const done = () => { el.textContent = '✓ Skopiowano'; };
    (navigator.clipboard?.writeText(FW_BOOKMARKLET) || Promise.reject()).then(done).catch(() => { prompt('Skopiuj ten kod:', FW_BOOKMARKLET); });
    return;
  }
  if (el.dataset.prof) { S.profPart = el.dataset.prof; render(); window.scrollTo(0, 0); return; }
  if (el.dataset.quick != null) { openQuick(); return; }
  if (el.dataset.tasteOpen != null) { openTaste(); return; }
  if (el.dataset.taste) { const [k, lv] = el.dataset.taste.split('|'); setTaste(k, lv); const y = $('#sheet .sheet-body').scrollTop; openTaste(); $('#sheet .sheet-body').scrollTop = y; return; }
  if (el.dataset.rrule) { const [k, lv] = el.dataset.rrule.split('|'), id = $('#sheet .sheet-body').dataset.id; S.local.taste = S.local.taste || {}; S.local.taste[k] = lv; for (const t of S.cat) t._rh = null; S.local.hidden[id] = 1; saveLocal(); closeSheet(); buildModel(); render(); return; }
  if (el.dataset.crit != null) { const i = +el.dataset.crit; S.critSel = S.critSel === i ? null : i; render(); return; }
  if (el.dataset.bak === 'export') { exportBackup(); return; }
  if (el.dataset.bak === 'restore') { restoreYesterday(); return; }
  if (el.classList.contains('row-link') && el.dataset.id) { openDetail(el.dataset.id); return; }
  if (el.dataset.surp != null) { const id = $('#sheet .sheet-body').dataset.id; S.local.surp = S.local.surp || {}; const v = +el.dataset.surp; if (S.local.surp[id] === v) delete S.local.surp[id]; else S.local.surp[id] = v; saveLocal(); buildModel(); openDetail(id); return; }
  if (el.dataset.aw) { const m = S.f.awSel = S.f.awSel || {}, k = el.dataset.aw, nx = { undefined: 'win', win: 'nom', nom: 'any', any: undefined }[m[k]]; if (nx) m[k] = nx; else delete m[k]; saveLocal(); openFilters(); return; }
  if (el.dataset.reason) { rejectWith($('#sheet .sheet-body').dataset.id, el.dataset.reason); return; }
  if (el.dataset.duel) { duelAnswer(el.dataset.duel); return; }
  if (el.dataset.duelskip != null) { S.duel = null; openDuel(); return; }
  if (el.dataset.remind) { openDetail(el.dataset.remind); return; }
  if (el.dataset.remindx) { S.local.remindSkip = S.local.remindSkip || {}; S.local.remindSkip[el.dataset.remindx] = 1; saveLocal(); render(); return; }
  if (el.dataset.fwdone) { S.local.fwDone = S.local.fwDone || {}; S.local.fwDone[el.dataset.fwdone] = 1; saveLocal(); render(); return; }
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
    if (['moods', 'periods', 'lens'].includes(k)) { const a = f[k], i = a.indexOf(v); i >= 0 ? a.splice(i, 1) : a.push(v); }
    if (k === 'sure') f.sure = !f.sure;
    if (k === 'critRec') f.critRec = !f.critRec;
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
  if (el.dataset.hide != null) { if (S.local.hidden[sid]) { delete S.local.hidden[sid]; delete (S.local.rejects || {})[sid]; saveLocal(); closeSheet(); buildModel(); render(); } else openReasons(sid); return; }
  if (el.dataset.set) { const i = el.dataset.set.indexOf(':'), k = el.dataset.set.slice(0, i), v = el.dataset.set.slice(i + 1); S.f[k] = k === 'minVotes' ? +v : v; saveLocal(); openFilters(); return; }
  if (el.dataset.arr) { const [k, v] = el.dataset.arr.split(':'); S.f[k] = S.f[k] || []; const a = S.f[k], i = a.indexOf(v); i >= 0 ? a.splice(i, 1) : a.push(v); saveLocal(); openFilters(); return; }
  if (el.dataset.toggle) { S.f[el.dataset.toggle] = !S.f[el.dataset.toggle]; saveLocal(); openFilters(); return; }
  if (el.dataset.reset != null) { S.f = DEFAULT_F(); saveLocal(); openFilters(); return; }
  if (el.dataset.resetQuick != null) { S.f = DEFAULT_F(); saveLocal(); render(); return; }
  if (el.dataset.id && (el.classList.contains('card') || el.classList.contains('tile') || el.classList.contains('hero'))) openDetail(el.dataset.id);
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.ms) { S.local.ms = Object.assign({}, MS_DEF, S.local.ms || {}, { [el.dataset.ms]: el.value }); S.limit = 40; saveLocal(); render(); return; }
  if (el.dataset.bakFile != null && el.files[0]) importBackup(el.files[0]);
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'likeq') { S.likeQ = el.value; clearTimeout(S._lq); S._lq = setTimeout(() => { renderLike(); const i = $('#likeq'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250); return; }
  if (el.id === 'q') { S.q = el.value.trim(); S.limit = 40; clearTimeout(S._qt); S._qt = setTimeout(render, 180); return; }
  if (el.dataset.f === 'bsort') { S.local.bsort = el.value; saveLocal(); return; }
  if (el.dataset.f) {
    S.f[el.dataset.f] = el.tagName === 'SELECT' && el.dataset.f === 'sort' ? el.value : +el.value;
    const out = el.parentElement.querySelector('output');
    if (out) out.textContent = +el.value ? (el.dataset.f === 'minRt' ? el.value + '%' : fmt(+el.value, el.step < 1 ? 1 : 0)) : 'dowolnie';
    saveLocal();
  }
});

if ('serviceWorker' in navigator) {
  const hadSW = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(r => r.update()).catch(() => {});
  let reloaded = false;   // nowa wersja przejęła stronę → odśwież raz
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadSW && !reloaded) { reloaded = true; location.reload(); } });
}
load();

/* Aplikacja z ekranu głównego wznawia się z tła bez przeładowania – po dłuższej przerwie wczytaj ją na nowo (nowe oceny, nowa wersja) */
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (hiddenAt && Date.now() - hiddenAt > 20 * 60 * 1000 && !document.querySelector('#sheet .sheet-body')) location.reload();
});
