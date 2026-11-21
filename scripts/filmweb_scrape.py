#!/usr/bin/env python3
"""Pobiera oceny i listę „Chcę zobaczyć" z PUBLICZNEGO profilu Filmwebu.

Filmweb nie ma publicznego API po nicku, więc otwieramy profil w przeglądarce
(Playwright/Chromium) i przechwytujemy odpowiedzi JSON, które strona sama pobiera
podczas przewijania listy. Dodatkowo zbieramy dane z DOM jako zabezpieczenie.

Wynik: state/filmweb_raw.json  {"votes": {"film": [...], "serial": [...]},
                                 "want": {"film": [...], "serial": [...]},
                                 "api_urls": [...], "dom": {...}}
"""
import json, os, re, sys, time
from playwright.sync_api import sync_playwright

USER = os.environ.get("FILMWEB_USER", "Bojryk")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state", "filmweb_raw.json")
SECTIONS = [("votes", "film"), ("votes", "serial"), ("want", "film"), ("want", "serial")]
HASH = {"votes": "votes", "want": "wantToSee"}

DOM_JS = r"""
() => {
  const out = [];
  document.querySelectorAll('a[href*="/vote/"]').forEach(a => {
    const m = a.getAttribute('href').match(/\/vote\/(film|serial)\/(\d+)/);
    if (!m) return;
    let box = a; for (let i = 0; i < 6 && box; i++) box = box.parentElement;
    let rate = null;
    if (box) {
      const nums = [...box.querySelectorAll('*')].filter(e => e.children.length === 0 && /^\d{1,2}$/.test(e.textContent.trim()));
      if (nums.length) rate = +nums[0].textContent.trim();
    }
    const tm = box && box.querySelector('time, [datetime]');
    out.push({ entity: +m[2], type: m[1], rate, date: tm ? (tm.getAttribute('datetime') || '') : '' });
  });
  document.querySelectorAll('a[href^="/film/"], a[href^="/serial/"]').forEach(a => {
    if (a.closest('footer, [role=contentinfo], header, nav')) return;
    const m = a.getAttribute('href').match(/^\/(film|serial)\/(.+)-(\d{4})-(\d+)$/);
    if (m) out.push({ entity: +m[4], type: m[1], title: a.textContent.trim() || null, year: +m[3], link: true });
  });
  return out;
}
"""


def dismiss(page):
    for sel in ['button:has-text("Nie akceptuj żadnego")', 'button:has-text("Akceptuję i przechodzę")',
                'button:has-text("Przejdź do Filmwebu teraz")', '#didomi-notice-disagree-button']:
        try:
            el = page.locator(sel).first
            if el.is_visible(timeout=500):
                el.click(timeout=2000)
                time.sleep(0.8)
        except Exception:
            pass


def main():
    captured = []   # (url, json)
    api_urls = []

    def on_response(resp):
        u = resp.url
        if "filmweb.pl/api/" not in u:
            return
        api_urls.append(f"{resp.status} {u}")
        if resp.status != 200:
            return
        try:
            captured.append((u, resp.json()))
        except Exception:
            pass

    res = {"votes": {}, "want": {}, "dom": {}, "api_urls": [], "errors": []}
    with sync_playwright() as p:
        br = p.chromium.launch()
        ctx = br.new_context(locale="pl-PL", viewport={"width": 1280, "height": 1600},
                             user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
        page = ctx.new_page()
        page.on("response", on_response)
        page.goto(f"https://www.filmweb.pl/user/{USER}", wait_until="domcontentloaded", timeout=60000)
        time.sleep(4)
        dismiss(page)
        time.sleep(16)  # reklama pełnoekranowa
        dismiss(page)
        for kind, typ in SECTIONS:
            start = len(captured)
            page.goto(f"https://www.filmweb.pl/user/{USER}#/{HASH[kind]}/{typ}", wait_until="domcontentloaded", timeout=60000)
            time.sleep(4)
            dismiss(page)
            dom_items, last, still = {}, -1, 0
            for _ in range(400):
                page.mouse.wheel(0, 2500)
                time.sleep(0.6)
                if _ % 5 == 0:
                    dismiss(page)
                    try:
                        for it in page.evaluate(DOM_JS):
                            k = (it["type"], it["entity"])
                            cur = dom_items.setdefault(k, {})
                            cur.update({x: y for x, y in it.items() if y not in (None, "")})
                    except Exception as e:
                        res["errors"].append(str(e)[:200])
                    n = len(captured) + len(dom_items)
                    still = still + 1 if n == last else 0
                    last = n
                    if still >= 4:
                        break
            res["dom"][f"{kind}/{typ}"] = list(dom_items.values())
            res[kind][typ] = [{"url": u, "data": d} for u, d in captured[start:]]
            print(f"{kind}/{typ}: api {len(captured) - start}, dom {len(dom_items)}", flush=True)
        br.close()
    res["api_urls"] = sorted(set(re.sub(r"\d{3,}", "N", u) for u in api_urls))[:80]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False)
    print("api url patterns:", *res["api_urls"][:40], sep="\n  ")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # nie blokuj reszty aktualizacji
        print("Filmweb scrape error:", e, file=sys.stderr)
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        if not os.path.exists(OUT):
            json.dump({"error": str(e)}, open(OUT, "w"))
