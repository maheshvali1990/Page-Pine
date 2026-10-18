# Page & Pine

A self-hosted, responsive book library and reader with a quiet, Kindle-inspired reading experience. It runs on Python and opens in a browser on your laptop, phone, or tablet. Your database and book files stay on your server.

## Start the server

1. Install Python 3.10 or newer.
2. From this folder, install dependencies:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   python -m pip install -r requirements.txt
   ```

3. Start Page & Pine:

   ```powershell
   python run.py
   ```

4. Open [http://localhost:8000](http://localhost:8000). On another device on the same Wi-Fi, open `http://<laptop-LAN-IP>:8000`; use `ipconfig` to find the laptop's private IPv4 address. Allow Python through the Windows firewall on private networks if prompted.

Keep the server running while other devices use the library. To move the database and books outside the project folder, set `PAGEANDPINE_DATA` before starting the server. SQLite migrations upgrade existing libraries in place; do not replace or delete the `data` directory.

### Use an existing library

The Git project intentionally does not include a `data` directory: your database and books are private application data, not source code. To open a library that already exists elsewhere, set `PAGEANDPINE_DATA` to that library's data folder before starting the server. For example, in PowerShell:

```powershell
$env:PAGEANDPINE_DATA = "C:\path\to\your\existing\data"
python run.py
```

Leave the setting in that PowerShell window for the server session. Do not copy book files, the database, or session secrets into the Git repository.

## Develop and version with Git

Python source is at the project root; the browser app and its locally hosted dependencies are in `static/`; backend tests are in `tests/`. Create and activate a virtual environment, install development dependencies, and run tests:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
pytest -q
```

The project folder is a local Git repository. Review and commit changes with:

```powershell
git status
git add .
git commit -m "Describe the change"
```

To publish it to a Git hosting service, first create an empty remote repository there, then connect and push this branch:

```powershell
git remote add origin <repository-URL>
git push -u origin main
```

Library data, local environments, and secrets are excluded by `.gitignore`. Third-party browser libraries and fonts are included with their license files under `static/`. No license has been selected for Page & Pine itself; choose one before distributing the project publicly if you want to grant reuse rights.

## Formats

EPUB, PDF, Word DOCX, TXT, Markdown, and HTML/HTM open directly. AZW3, AZW, MOBI, RTF, ODT, FB2, CBZ/CBR, and other formats supported by [Calibre](https://calibre-ebook.com/) can be converted to EPUB when Calibre's `ebook-convert` command is installed and available on `PATH`. Legacy `.doc` files are not supported. DRM-protected, corrupted, or unsupported files cannot be read; DRM removal is not supported.

The reader includes a real-cover library with progress, search, favorites, status and metadata editing, collections, sidebar tag filters, and delete confirmation. EPUB, PDF, and text readers support saved reading preferences and positions; EPUB/PDF also support in-book search. PDF offers fit, zoom, page navigation, selectable text, dark mode, and continuous lazy rendering. Highlights, notes, and bookmarks can be edited and exported as Markdown or JSON.

## Reading on mobile and offline

The responsive web app can be installed as a PWA where the browser supports installation. Its app shell and locally opened book files are cached on that device for offline reading. Offline app installation and service workers require `localhost` or HTTPS; ordinary HTTP on a private Wi-Fi address can still be used online, but browsers generally do not enable PWA offline features there. Offline book-file caching is disabled while PIN protection is enabled.

Device reading positions are stored separately, so the app can offer a prompt when another device is further ahead. This is not cloud sync: devices need access to the same running Page & Pine server to exchange their progress.

### E-ink reading

Choose **E-ink** or **E-ink Dark** in Reading settings for a monochrome library and reader with Literata typography, paginated reading, grayscale covers and images, and larger page-turn tap zones. The optional **Page refresh flash** setting flashes after the configured number of page turns (8 by default) and when the EPUB chapter changes; it is off by default and unavailable when reduced motion is requested. The theme and flash preferences are saved on that device. Literata WOFF2 files are self-hosted in `static/fonts`; the font is licensed under the SIL Open Font License.

## Optional features

### PIN protection

Set a shared PIN in the server environment before startup:

```powershell
$env:PAGEANDPINE_PIN = "choose-a-long-random-pin"
python .\run.py
```

The PIN protects API and OPDS access and has rate limiting. It is a lightweight shared-library gate, not per-user accounts. Use HTTPS for untrusted networks and do not expose the server directly to the public internet. Without a PIN, anyone who can reach the server can access the library and its files.

### Watch-folder imports

Set `PAGEANDPINE_INBOX` to a folder before startup. Supported files placed there are imported automatically; completed imports are moved into `imported`, duplicate files into `duplicates`, and rejected files into `rejected`. The inbox is checked periodically while the server is running.

### OPDS catalog

The acquisition feed is available at `http://<server>:8000/opds` for compatible reading apps. When PIN protection is enabled, authenticate with the same PIN/session before accessing it.

### Chapter summaries and passage explanations with AI

AI is disabled by default. To enable it, set all of the following server-side environment variables:

```powershell
$env:PAGEANDPINE_AI_ENABLED = "true"
$env:PAGEANDPINE_AI_API_KEY = "<provider-key>"
$env:PAGEANDPINE_AI_BASE_URL = "https://<provider-api-base>"
$env:PAGEANDPINE_AI_MODEL = "<model-name>"
python .\run.py
```

The API key stays on the server. For an open EPUB, the reader can request a concise summary of the current chapter; selected passages can also be explained. Before a request, the app tells the reader what excerpt and question will be sent to the configured provider and asks for confirmation. Use a trusted provider and review its data-retention terms. These helpers are rate-limited and accept HTTPS provider URLs (localhost is allowed for development).

### Speech

Text-to-speech uses the browser's Web Speech API and its installed voices. While supported, the footer follows the sentence being spoken. Voice availability and whether speech works offline depend on the browser and operating system.

## Privacy and dependencies

Book files, metadata, reading progress, annotations, collections, tags, and statistics are kept in the local Page & Pine data directory. EPUB.js, JSZip, PDF.js, the reading fonts, and their licenses are included locally under `static/vendor` and `static/fonts`; these readers do not require a CDN. The optional Dictionary lookup sends the selected word to Free Dictionary only after confirmation. The optional AI feature sends the selected excerpt and question to the server-configured external provider only after confirmation.

Do not expose this development-style self-hosted app to the public internet. For remote access, place it behind a properly secured HTTPS reverse proxy and use a strong PIN.

## Tests

Install development dependencies and run the backend tests:

```powershell
python -m pip install -r requirements-dev.txt
pytest -q
```
