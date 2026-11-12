# Simple Label Printer

A dead-simple, offline web app for printing text labels on a **Supvan E10** (Katasymbol E10) or
**Phomemo Q30** thermal label printer. Built as a replacement for the SUPRINT app for someone who just wants to
type a word and get a label.

- **Type → Print.** One text box, a live preview, one big button. Hebrew UI.
- **Works offline.** Installable PWA; after the first load everything (incl. the font) is cached.
- **Detects the loaded tape** (reads the tape's RFID chip: continuous 12/15 mm, die-cut 12×40,
  15×30, …, color) and re-checks every 5 s, so swapping rolls just works.
- **Auto-sizes.** Text is drawn as large as the tape allows. On continuous tape the label is as long
  as the text; on die-cut labels the text shrinks/wraps (up to 3 lines) to fit.
- **Hebrew / RTL.** Direction per line from the first strong character, so Hebrew, English and
  numbers mix correctly ("סוכר חום 2025"). Uses the bundled Heebo font.

## Phomemo Q30

Connect the same way (it shows up as `Q30…`); the app recognizes it by name/service. Differences:

- **No tape detection**: the Q30 doesn't report its labels. Pick the roll once in ⚙ →
  **סוג מדבקה (Phomemo Q30)** (default 14×40 mm). Text then auto-sizes for that label.
- No status (paper out, cover, battery) is read, so errors aren't shown; copies are sent with a
  fixed pause between them.
- Protocol from [flyingmaulwurf/ha-phomemo-q30](https://github.com/flyingmaulwurf/ha-phomemo-q30)
  (confirmed on a real Q30 with gap labels), [dmsc/web-label-printer](https://github.com/dmsc/web-label-printer)
  and [vivier/phomemo-tools](https://github.com/vivier/phomemo-tools). Continuous-roll mode
  (`1F 11 0B`) is from the M110 docs and untested on a Q30. The raster is always 96 dots (12 mm)
  across, like every working D30/Q30 client (a 112-dot raster for 14 mm labels printed nothing).
- If nothing prints, try ⚙ → **פקודות Q30 → חלופי** (plain ESC/POS, as dmsc/odensc send), and
  check ⚙ → יומן תקשורת for what was sent and what the printer answered on `ff03`.
- Tested only against a recording fake in Chromium, not on a physical Q30.

## Requirements

Chrome (or Edge) on Android, Windows, macOS, Linux or ChromeOS — it needs Web Bluetooth.
iOS/Safari and Firefox don't support it. The page must be served over HTTPS (GitHub Pages is fine).

## Setup (once)

1. Deploy: enable **Settings → Pages → Source: GitHub Actions** in this repo; pushes to `main` deploy.
   Or run `npm ci && npm run build` and host `dist/` anywhere with HTTPS.
2. On the phone, open the page in Chrome, then **⋮ → Add to Home screen**. It now opens like an app,
   with or without internet.
3. Turn the printer on, tap **חיבור והדפסה** and pick the printer from the list (it shows up as
   `T0…`, its serial number, not "E10").
4. If the first label comes out upside down, open ⚙ and tick **סיבוב 180°**. Use **הדפסת בדיקה**
   to check alignment and darkness.

### Avoiding the device picker every time

Web Bluetooth asks for the printer once per page load. Two ways to make it automatic:

- **BLE (default):** in Chrome open `chrome://flags/#enable-web-bluetooth-new-permissions-backend`,
  enable it and restart Chrome. The app then reconnects to the remembered printer on its own.
- **Classic Bluetooth (Serial):** pair the printer in Android's Bluetooth settings, then choose
  **בלוטות׳ קלאסי (Serial)** in ⚙. Chrome remembers the serial permission, so it reconnects
  silently. (Needs a recent Chrome with Web Serial over Bluetooth.)

## Settings (⚙)

| Setting | What |
|---|---|
| חיבור | BLE or classic Bluetooth (Serial) |
| סוג מדבקה | Auto-detect (default) or force a tape size if detection fails |
| כהות הדפסה | Darkness 1–7 |
| עובי אותיות | Font weight |
| גודל טקסט בגליל רציף | Text height on continuous tape (smaller = shorter labels) |
| סיבוב 180° | Flip output |
| יומן תקשורת | Raw protocol log, for debugging |

## Status / caveats

- The printer protocol (E10 = Supvan "T15" family) is vendored from
  [khromov/supvan-katasymbol-printer-web-ui](https://github.com/khromov/supvan-katasymbol-printer-web-ui)
  (MIT), whose author printed on a real E10 over BLE (macOS Chrome) and classic Bluetooth (Android
  Chrome). This app was tested against that project's printer emulator (unit tests + full UI flow in
  Chromium with a fake Bluetooth device), **not yet on a physical E10**. Expect to possibly need the
  180° toggle or a darkness tweak on first use.
- The E10 head is 12 mm (96 dots, 8 dots/mm); like the vendor app only the middle 88 dots
  (11 mm) are printed, so on 15 mm tape there's a blank strip along both edges.

## Development

```sh
npm ci
npm run dev     # http://localhost:5173 (Web Bluetooth works on localhost)
npm test        # protocol + tape-detection tests against the emulator
npm run build   # static site in dist/
```

| Path | What |
|---|---|
| `src/main.ts` | UI |
| `src/render.ts` | Text → 1-bit label bitmap: auto font size, wrapping, RTL |
| `src/tape.ts` | Tape id → size/type/color (catalog in `src/tapes.json`) |
| `src/connection.ts` | Connect/reconnect (BLE or Serial), status + tape polling, print |
| `src/q30.ts` | Phomemo Q30 encoder + BLE writer |
| `src/printer/` | Vendored E10 driver, framing, transports, LZMA (see `LICENSE-khromov`) |
| `test/` | Vitest tests, vendored emulator, fake Web Bluetooth for browser testing |

## License

MIT. `src/printer/*`, `src/tapes.json` and `test/t15-emulator.ts` are from
khromov/supvan-katasymbol-printer-web-ui (MIT, © 2026 Katasymbol Web contributors); the LZMA
encoder is LZMA-JS (MIT, © 2015 Nathan Rugg) as modified for Supvan printers.
