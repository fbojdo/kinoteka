# Kinoteka

Prywatna aplikacja (PWA) o filmach i serialach dla iPhone'a. Zawiera:

- Twoje oceny i listę „Chcę zobaczyć” z Filmwebu (profil **Bojryk**), synchronizowane co noc,
- katalog około 15 tys. tytułów z ocenami **Filmweb, IMDb, Rotten Tomatoes, Metacritic i TMDB**,
- filtry: serwis VOD w Polsce (Netflix, Apple TV+, Max, Disney+, Prime…), nagrody (Oscary, Złote Globy, Cannes, Wenecja, Berlinale, BAFTA, Emmy, Orły, Gdynia…), lata produkcji, gatunek, kraj, długość, minimalne oceny,
- rekomendacje z przewidywaną oceną i uzasadnieniem oraz zakładkę **Trafność**, która uczciwie mierzy, jak dobrze model przewiduje Twoje oceny.

## Jednorazowa konfiguracja

1. **Klucze API** (oba darmowe):
   - TMDB: https://www.themoviedb.org/settings/api → „API Key”
   - OMDb (Rotten Tomatoes i Metacritic): https://www.omdbapi.com/apikey.aspx → FREE
2. W repozytorium: **Settings → Secrets and variables → Actions → New repository secret**
   - `TMDB_KEY` = klucz TMDB
   - `OMDB_KEY` = klucz OMDb
3. **Settings → Pages → Source: GitHub Actions**
4. **Actions → „Aktualizacja danych i publikacja” → Run workflow**. Pierwsze uruchomienie trwa 30–60 minut.
5. Otwórz adres strony w Safari na iPhonie → **Udostępnij → Do ekranu początkowego**.

## Jak to działa

- `scripts/update_data.py` uruchamia się co noc w GitHub Actions. Pobiera dane i publikuje stronę na GitHub Pages. Stan między uruchomieniami trzymany jest w cache Actions.
- Oceny RT i Metacritic z OMDb dochodzą stopniowo, około 950 tytułów dziennie (limit darmowego klucza).
- Model rekomendacji działa w telefonie (`app.js`). To regresja grzbietowa, która łączy jakość tytułu (oceny portali) z Twoim gustem: gatunki, motywy, reżyserzy, scenarzyści, aktorzy, kraje, epoki oraz podobieństwo do tytułów, które już oceniłeś. Uczy się na cechach liczonych metodą leave-one-out. Trafność sprawdzana jest na trzy sposoby: walidacją krzyżową, testem w czasie (stare oceny przewidują nowe) oraz na żywo (prognozy zapisane, zanim coś obejrzysz).

Źródła: Filmweb (nieoficjalne API publicznego profilu), TMDB, IMDb Datasets, OMDb, JustWatch (przez TMDB), Wikidata.
Ten produkt korzysta z API TMDB, ale nie jest przez TMDB wspierany ani certyfikowany.
