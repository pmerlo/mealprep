# Meal prep tracker

Log what you cooked, how many portions it made, and tap **Eat one** each time you take a portion.
Batches turn from green to red as they run down, and fridge batches warn you on day 3.

It is a single Node.js server (Express) that serves the page and a small JSON API, and keeps
everything in one SQLite file. The page works offline: taps are queued on the device and sync
when you're back online. Two people eating from the same batch at once never lose a portion.

## Run it locally

Needs Node.js 22.13 or newer (SQLite is built into Node, so there is nothing else to install).

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000. The database is created at `data/mealprep.db`.

## Settings

| Variable | What it does |
| --- | --- |
| `APP_PASSWORD` | Optional. When set, the app asks for this password once per device. Leave it unset and anyone with the URL can use it. |
| `SESSION_SECRET` | Optional. A long random string used to sign the login cookie. Defaults to `APP_PASSWORD`. Changing either one signs every device out. |
| `DATABASE_PATH` | Optional. Where the SQLite file lives. Defaults to `$RAILWAY_VOLUME_MOUNT_PATH/mealprep.db` on Railway, or `data/mealprep.db` locally. |
| `PORT` | Set by Railway automatically. Defaults to 3000. |

## Deploy on Railway

1. In Railway, choose **New Project → Deploy from GitHub repo** and pick `pmerlo/mealprep`.
2. **Attach a volume** to the service, with mount path `/data`. Without a volume, the SQLite
   file is wiped on every deploy. The app finds the volume on its own through
   `RAILWAY_VOLUME_MOUNT_PATH`.
3. Under the service's **Variables**, add `APP_PASSWORD` (and optionally `SESSION_SECRET`).
4. Under **Settings → Networking**, choose **Generate Domain** to get a public URL.

`railway.json` sets the start command and a health check on `/healthz`. Every push to the
connected branch redeploys.

On a phone, open the URL and use **Add to Home Screen** to get it as an app icon.

## Backups

All data is the one file on the volume. To keep a copy, download `mealprep.db` from the
volume, or run `sqlite3 /data/mealprep.db ".backup backup.db"` in the service shell.

## API

All routes need the login cookie when `APP_PASSWORD` is set.

- `GET /api/batches`: every batch
- `PUT /api/batches/:id`: create or replace a batch (`name`, `cooked`, `total`, `left`, `storage`, `tags`, `created`)
- `POST /api/batches/:id/adjust`: `{ "delta": -1 }` to eat a portion, `1` to put one back
- `DELETE /api/batches/:id`: delete a batch
- `GET /healthz`: health check, no login needed
