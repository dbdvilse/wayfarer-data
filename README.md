# wayfarer-data

The data files the Wayfarer game downloads at start-up (monsters, items, spells, balance numbers...). Static files only, served by
Cloudflare Workers static assets (`wrangler.jsonc`, folder `public`).

- `public/manifest.json`: which version is the latest, where its file is, and its SHA-256 checksum. The game reads this small file first.
- `public/data/game-data-<version>.json`: one immutable file per published version. Never edit a published file: publish a new version.
- A roll-back is the old numbers published as a new, higher version (the game never goes back to an older version number).

Files are published from the Wayfarer game repository by its publish script, which runs the data checks first.
