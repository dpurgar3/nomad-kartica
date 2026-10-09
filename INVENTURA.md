# NOMAd Inventura

Web-aplikacija za inventuru, prilagođena Remarisu. Radi na istom serveru kao kartica vjernosti, na adresi **/inventura** (npr. `https://nomad-kartica.onrender.com/inventura`).

## Što radi (verzija 1)

- **Artikli i kategorije**: šifra (Remaris šifra ili automatska `N-001`), naziv, kategorija, dobavljač, osnovna jedinica (kom, l, dl, ml, kg, g), nabavna cijena bez PDV-a, stopa PDV-a, minimalna zaliha, aktivan/neaktivan.
- **Pakiranja**: npr. „Gajba 24” = 24 kom ili „Boca 0,7 l” = 0,7 l. Pri brojanju ili nabavi upisuješ broj pakiranja, a aplikacija preračuna u osnovnu jedinicu. Nekompatibilne jedinice (npr. kg i l) se ne zbrajaju. Takav unos se odbija.
- **Promjene zaliha**: nabava, otpis, lom, interno korištenje i ručna korekcija. Svaka ima datum, artikl, količinu, razlog i korisnika.
- **Inventura**:
  - otvaranje s datumom i lokacijom;
  - očekivano (knjižno) stanje naspram prebrojanog;
  - razlika = prebrojano − očekivano (višak / manjak) i njezina vrijednost;
  - neprebrojani artikli su označeni;
  - rad se sprema u tijeku;
  - pregled prije zaključivanja;
  - nakon zaključivanja izmjene su moguće samo kao ispravak s razlogom, a stara vrijednost ostaje zapisana.
- **Glasovni unos**: na listi za brojanje pritisni 🎤 i reci npr. „coca cola dvadeset četiri”, „jamnica dvije gajbe” ili „limun jedan i pol kila”.
  - Prije upisa vidiš što je prepoznato i potvrđuješ s „= Postavi” ili „+ Dodaj”.
  - Mikrofon postoji i u pretrazi artikala i u obrascu promjena zaliha.
  - Radi u Chromeu (Android, računalo) i Safariju (iPhone, uz uključen Siri / diktiranje).
  - Prepoznavanje govora obavlja preglednik, odnosno Google ili Apple, pa je za to potreban internet.
- **Uvoz iz Remarisa**: PDF izvještaj „Skladišna stanja” → pregled razlika → potvrda. Knjižno stanje postaje jednako Remarisovom.
- **Izvještaji**:
  - ukupna vrijednost zaliha;
  - manjkovi i viškovi po inventuri;
  - zalihe ispod minimuma;
  - vrijednost po kategorijama;
  - povijest inventura;
  - dnevnik promjena;
  - CSV za Excel (separator `;`, decimalni zarez, UTF-8).

## Početno stanje

Kod prvog pokretanja baza se puni iz `inventura/seed/stanje-2026-10-09.json`:

- **113 artikala** sa stanjem iz Remaris izvještaja „Skladišna stanja” (skladište Glavno, 9.10.2026. 17:00);
- **zadnje nabavne cijene bez PDV-a** iz Remaris analize primki (17.9.2024.–16.9.2026., skladište Glavno). 102 artikla imaju cijenu.

Artikli **bez cijene** (cijenu upiši u Artiklima): Schweppes sokovi razni 0,25 l, Mineralna voda Jamnica 1 l, Vino crveno 0,75 l, Lozovača, Rum punč, Limoncello, Bulldog gin, Gentleman Jack, Courvoisier, Martell, Gin (zadužni).

U Remarisu su tri artikla imala **negativno stanje** (Grif IPA −2, Limun −1,0844, Grejp −0,885). Prenesena su kakva jesu. Inventura će ih ispraviti.

## Kako se računa knjižno stanje

```
knjižno stanje = početno stanje (Remaris 9.10.2026.)
               + usklađenja s Remarisom (uvoz novog PDF-a: tu ulaze prodaja i primke iz Remarisa)
               + promjene upisane u aplikaciji (nabava, otpis, lom, interno, korekcija)
               + inventurne razlike i ispravci
```

Aplikacija ne prati prodaju. Prodaja je u Remarisu. Zato **prije svake inventure uvezi svježi PDF „Skladišna stanja”** (Postavke → Uvoz iz Remarisa). Svaka stavka čuva se kao zasebno knjiženje, ništa se ne briše, pa se početno stanje, upisane promjene i fizičko stanje uvijek mogu razlikovati.

Promjene knjižene **tijekom** inventure su vidljive kao „sada …” uz očekivanu količinu. Razlika se kod zaključivanja računa prema knjižnom stanju u trenutku zaključivanja. Tako dostava stigla usred brojanja ne ispadne kao višak.

## Metoda vrednovanja

- Vrijednost = količina × **zadnja nabavna cijena bez PDV-a** po osnovnoj jedinici.
- Izvor cijene: Remaris primke, nakon toga zadnja nabava upisana u aplikaciji (s cijenom).
- Prodajne cijene i PDV se ne koriste i ne miješaju.
- Negativno knjižno stanje ne ulazi u vrijednost zaliha. Artikli bez cijene su navedeni zasebno.
- Inventurne razlike vrednuju se po cijeni zapisanoj kod otvaranja (ili „Osvježi očekivano”) inventure.
- Izračun koristi cijele brojeve: količine i cijene ×10 000, iznosi u centima, zaokruživanje pola od nule. Nema pogrešaka zaokruživanja pomičnog zareza.
- Ovo nije računovodstveno ili porezno usklađen obračun. Služi za kontrolu zaliha.

## Prijava

Prijava je s jednim osobnim PIN-om. Implementirano i pokriveno testovima:

- PIN se čuva samo kao scrypt hash sa solju;
- sesija se čuva u HttpOnly kolačiću (SameSite=Strict, Secure preko HTTPS-a) i istječe za 30 dana;
- u bazi je samo SHA-256 tokena;
- nakon 8 pogrešnih pokušaja s iste IP adrese slijedi blokada od 15 minuta;
- promjene traže posebno zaglavlje, pa ih druga stranica ne može poslati u tvoje ime.

**Prvo pokretanje**: otvori `/inventura`, upiši PIN osoblja koji već koristiš za karticu (`ADMIN_PIN`) i postavi novi osobni PIN. Mijenja se u Postavkama.

**Alternativa**: na Renderu postavi varijablu `INVENTURA_PIN`. Tada vrijedi samo taj PIN.

Nema više korisnika ni uloga, nema dvofaktorske prijave.

## Pokretanje lokalno

```
npm install
ADMIN_PIN=1234 npm start      # http://localhost:3000/inventura
npm test                      # svi testovi (node:test)
```

Baza inventure je u zasebnoj datoteci `data/inventura.db` (SQLite) pored baze kartice. Na Renderu je na trajnom disku. Migracije (`inventura/db.js`) se izvode automatski pri pokretanju, samo jednom, i nikad ne brišu podatke.

## Sigurnosna kopija i vraćanje

- **Kopija**: Postavke → *Preuzmi kopiju baze*. Dobiješ datoteku `inventura-kopija-DATUM.db`. Preporuka: nakon svake zaključene inventure.
- **Vraćanje**:
  1. Zaustavi servis.
  2. Na Render disku zamijeni `/opt/render/project/src/data/inventura.db` kopijom: Render Shell, ili privremeno postavi `INVENTURA_DB_FILE` na drugu putanju.
  3. Obriši `inventura.db-wal` i `inventura.db-shm`.
  4. Pokreni servis.
- Render disk ima i svoje dnevne snimke (Render → Disks → Snapshots).

## Struktura

| Sloj | Datoteke |
|---|---|
| Prezentacija | `inventura/routes.js` (HTTP API), `inventura/public/` (sučelje), `inventura/csv.js` |
| Poslovna logika | `inventura/service.js`, `inventura/logic.js`, `inventura/decimal.js`, `inventura/remaris.js`, `inventura/auth.js`, `inventura/public/voice.js` (glasovni unos) |
| Podaci | `inventura/db.js` (shema i migracije) |
| Testovi | `test/inventura.test.js` |

## Ograničenja verzije 1

- Prodaja i normativi (receptura) nisu u aplikaciji. Stanje nakon prodaje dolazi uvozom PDF-a iz Remarisa.
- Jedan korisnik. Lokacije se mogu dodati, ali sučelje radi s prvom (Glavno), kao skladište u Remarisu.
- Stope PDV-a nisu bile u Remaris podacima. Mogu se upisati ručno, ali se nigdje ne koriste u izračunu.
- Uvoz čita samo Remaris PDF „Skladišna stanja” u postojećem rasporedu. Ako Remaris promijeni izgled izvještaja, uvoz treba prilagoditi.
- Glasovni unos ovisi o pregledniku i internetu. Firefox ga nema. Prepoznavanje sličnih naziva nije savršeno, zato se svaki unos potvrđuje.
