# wayfarer-data

The data files the Wayfarer game downloads at start-up (monsters, items, spells, balance numbers...). Static files only, served by
Cloudflare Workers static assets (`wrangler.jsonc`, folder `public`).

- `public/manifest.json`: which version is the latest, where its file is, and its SHA-256 checksum. The game reads this small file first.
- `public/data/game-data-<version>.json`: one immutable file per published version. Never edit a published file: publish a new version.
- A roll-back is the old numbers published as a new, higher version (the game never goes back to an older version number).

Files are published from the Wayfarer game repository by its publish script, which runs the data checks first.

## Play statistics (optional, item 149)

`src/index.js` is a small Worker that runs only for `/api/*` (see `wrangler.jsonc`): it receives batches of anonymous play log lines from phones whose
players agreed to share them, rebuilds each line from an allow-list of game fields, and stores them in the D1 database `wayfarer-stats`
(`schema.sql`). It stores no IP address and no identifier of the sender. Details: docs/PLAY-LOG.md and docs/PRIVACY.md in the game repository.
