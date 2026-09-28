# pinterest-sync

Copies new pins from public Pinterest boards into Google Drive (full-size originals, no edits).

- Boards are listed at the top of `worker.js` (`BOARDS`). Add a line per new board; its Drive
  subfolder is created automatically inside the root folder.
- Runs weekly (Sunday) via `.github/workflows/pinterest-sync.yml`, which calls `POST /sync?board=<key>`
  until `remaining` is 0. Can also be run by hand from the Actions tab.
- Secrets (Cloudflare): `GOOGLE_SA_KEY`, `DRIVE_ROOT_FOLDER_ID`, `SYNC_TOKEN`. KV binding: `SEEN`.
- GitHub repo secrets for the workflow: `SYNC_URL` (Worker URL, no trailing slash), `SYNC_TOKEN`.
- Test routes (Bearer token required): `/test-pinterest`, `/test-drive`, `/boards`. `/health` is open.
- Pins are never deleted from Drive, even if removed from Pinterest.
