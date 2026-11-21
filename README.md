# NOMAd kartica vjernosti

Web aplikacija za goste NOMAd Caffe Bara (Ugostiteljski obrt Artist, Kulturni centar Ivan Rabuzin, Novi Marof).

Gost skenira QR kod na fiskalnom računu i dobiva **+10 bodova**. Za **50 bodova** dobiva nagradu **kava + kroasan**. Nagradu pokaže konobaru kao QR kod.

Aplikacija radi u pregledniku mobitela, pa je ne treba skidati s App Storea ni Google Playa. Gost je može dodati na početni zaslon i tada izgleda kao prava aplikacija.

## Što je u paketu

| Dio | Adresa | Čemu služi |
|---|---|---|
| Aplikacija za goste | `/` | Izrada kartice (ime, mobitel, PIN), fotografiranje računa, bodovi, nagrade, Wi-Fi |
| Ekran za osoblje | `/osoblje` | Potvrda nagrade (kamera ili upis koda), ručno dodavanje bodova, statistika |
| Server | `server.js` | Node.js + Express, baza SQLite (`data/nomad.db`) |

## Pokretanje (za programera)

Potrebno: Node.js 18 ili noviji.

```bash
npm install
cp .env.example .env     # zatim u .env upiši ADMIN_PIN i WIFI_PASSWORD
npm start                # aplikacija radi na http://localhost:3000
```

### Postavljanje na internet

**Najlakše: Render (bez programera).** U paketu je `render.yaml`, pa Render sam postavi server, disk za bazu i HTTPS.
1. Napravi besplatan račun na github.com i novi repozitorij `nomad-kartica` (Private).
2. „uploading an existing file“ → povuci sve datoteke iz mape (ne samo mapu) → Commit.
3. Na render.com se prijavi preko GitHuba → New → Blueprint → odaberi `nomad-kartica`.
4. Upiši `ADMIN_PIN` (PIN osoblja) i `WIFI_PASSWORD`, dodaj karticu za plaćanje i potvrdi (oko 7 USD mjesečno).
5. Za par minuta aplikacija radi na adresi oblika `https://nomad-kartica.onrender.com`.

Ostale mogućnosti:

1. **HTTPS je obavezan**, jer bez njega mobitel ne da pristup kameri. Prijedlog je poddomena, npr. `kartica.nomadinfo.space`.
2. Najjednostavnija je opcija mali VPS (npr. Hetzner ili DigitalOcean, oko 5 €/mj.):
   - pokrenuti `npm start` preko `pm2` ili `systemd`
   - ispred servera staviti **Caddy**, koji sam postavlja HTTPS certifikat:
     ```
     kartica.nomadinfo.space {
       reverse_proxy localhost:3000
     }
     ```
3. Može i Render ili Railway, ali tada treba **trajni disk** za `data/nomad.db`, inače se bodovi brišu pri svakom ponovnom pokretanju.
4. **Sigurnosna kopija:** jednom dnevno kopirati datoteku `data/nomad.db`.
5. Na stolove i šank postaviti QR kod koji vodi na adresu aplikacije.

## Postavke (`.env`)

| Postavka | Zadano | Opis |
|---|---|---|
| `ADMIN_PIN` | – | PIN za ekran osoblja. Bez njega je ekran za osoblje isključen. |
| `WIFI_SSID` / `WIFI_PASSWORD` | ASUS - NOMAd / – | Prikazuje se gostima u aplikaciji. |
| `POINTS_PER_RECEIPT` | 10 | Bodovi po računu |
| `REWARD_POINTS` | 50 | Bodovi potrebni za nagradu |
| `REWARD_NAME` | Velika kava s mlijekom + kroasan | Naziv nagrade |
| `REWARD_VALID_DAYS` | 30 | Koliko dana vrijedi kod nagrade |
| `MAX_RECEIPTS_PER_DAY` | 1 | Najviše računa po gostu dnevno |
| `RECEIPT_MAX_AGE_MINUTES` | 30 | Do koliko minuta nakon izdavanja se račun može skenirati (30 = pola sata) |
| `MIN_RECEIPT_CENTS` | 0 | Najmanji iznos računa za bodove (u centima) |
| `NOMAD_OIB` | 53253782263 | OIB koji mora biti na računu da bi se dodali bodovi |

## Kako aplikacija provjerava račun

Gost **fotografira cijeli račun** (od naziva lokala do QR koda). Server s iste fotografije čita:

1. **QR kod** fiskalnog računa (`https://porezna.gov.hr/rn?jir=…&datv=…&izn=…`): JIR, vrijeme i iznos,
2. **OIB izdavatelja** otisnut na vrhu računa (čitanje teksta, OCR).

QR kod fiskalnog računa ne sadrži OIB, zato se OIB čita s fotografije. Bodovi se daju samo ako je na računu OIB obrta Artist (`NOMAD_OIB`, zadano 53253782263).

Bodove odbija ako:

- račun nije iz NOMAd-a (na računu je drugi OIB ili se OIB ne vidi),
- je isti račun već iskorišten (svaki JIR vrijedi samo jednom),
- je gost danas već skenirao račun (najviše 1 dnevno),
- je račun stariji od 30 minuta (račun vrijedi samo ako se skenira odmah nakon plaćanja).

Ako se pravi NOMAd račun ne uspije pročitati (zgužvan, mutan), konobar može dodati bodove ručno na `/osoblje`.

## Nagrada

1. S 50 bodova gost dodirne **„Preuzmi nagradu“**. Bodovi se oduzimaju i nastaje jednokratni kod `NMD-XXXX-XXXX` s QR kodom, koji vrijedi 30 dana.
2. Konobar na `/osoblje` skenira ili upiše kod i dodirne **Potvrdi**. Kod se ne može iskoristiti ponovno.

## Zaštita podataka (GDPR)

- Spremaju se samo **ime, broj mobitela, PIN (šifriran) i povijest bodova**.
- Gost pri izradi kartice daje privolu. Tekst privole nalazi se u `public/index.html`.
- Gost može zatražiti brisanje podataka u lokalu ili na artistdrazen@gmail.com. Brisanje radi programer izravno u bazi.
- Preporuka: na web stranici objaviti kratku izjavu o privatnosti za karticu vjernosti.

## Datoteke

```
server.js                 server i sva pravila
receipt-check.js          čitanje QR koda i OIB-a s fotografije računa
public/index.html         aplikacija za goste
public/app.js, app.css    logika i izgled (crno-zlatno)
public/osoblje.html, .js  ekran za osoblje
public/manifest.webmanifest, sw.js   „dodaj na početni zaslon“
public/logo-*.png         NOMAd logo
.env.example              primjer postavki
```
