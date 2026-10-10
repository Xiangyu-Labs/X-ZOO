# `deploy/` — running the shop

The production stack is one Compose project, `x-zoo`, on one host:

| Service    | What it is                                                                                  | Memory cap |
| ---------- | ------------------------------------------------------------------------------------------- | ---------- |
| `postgres` | PostgreSQL 17, the only database                                                            | 512 MiB    |
| `redis`    | Redis 7 with `noeviction` and AOF: admin sessions, the config cache and the BullMQ queue    | 160 MiB    |
| `web`      | the Next.js server: `/admin`, `/admin-api/*`, the storefront API `/api/v1`, `/scan-upload/` | 512 MiB    |
| `worker`   | the BullMQ worker: repeatable jobs, the post-commit effects dispatcher                      | 320 MiB    |
| `edge`     | nginx: a proxy to `web` (the landing page at `/`), `/uploads/`, the verification files      | 64 MiB     |
| `migrate`  | a one-shot (profile `migrate`) that applies the migrations and the reference seed           | 384 MiB    |

The images are built in CI and pinned by digest. A host needs Docker with Compose v2, `curl`,
and nothing else: no Node, no pnpm, no build toolchain, no checkout of the repository.

Two commands run the shop:

- **`deploy/ship.sh`**, on a machine with the repository, releases a commit in one command and
  forwards everything else to the host over SSH;
- **`shop`**, on the host, is everything done to the running stack: `upgrade`, `rollback`,
  `backup`, `status`, and a few helpers.

## Files

| File                     | What it is                                                                                  | On the host |
| ------------------------ | ------------------------------------------------------------------------------------------- | ----------- |
| `ship.sh`                | releases a commit to the host, and forwards `status`, `backup` and `rollback` to it         | no          |
| `ship.local.env.example` | the template for `ship.local.env`, which is gitignored and names the host and its directory | no          |
| `shop`                   | the host command. `shop help` lists its subcommands.                                        | yes         |
| `lib/commands/`          | one file per `shop` subcommand: `upgrade.sh`, `rollback.sh`, `backup.sh`, `status.sh`, …    | yes         |
| `lib/`                   | shared shell: the Compose wiring, digest capture, the readiness gate                        | yes         |
| `compose.yml`            | the stack. It publishes only the edge, and only on loopback.                                | yes         |
| `compose.traefik.yml`    | the overlay that puts the edge behind Traefik; `NEXT_COMPOSE_OVERLAYS` applies it           | yes         |
| `deployment.env.example` | the template for `deployment.env`, which holds the passwords and is never tracked           | yes         |
| `rehearsal/`             | the drill that deploys, breaks and rolls back a throwaway copy of this stack                | no          |

## The host

On the production host the release directory is `/home/ubuntu/apps/X-ZOO`. It holds what this
directory ships, at its root, and three things that belong to the host and that no release
touches:

```text
/home/ubuntu/apps/X-ZOO/
  shop  compose.yml  compose.traefik.yml  deployment.env.example  lib/   ← shipped
  deployment.env                                                         ← the host's settings, mode 600
  REVISION                                                               ← the commit that is running
  data/backups/       dumps, upgrade manifests, settings backups
  data/releases/      one log per ship
  data/shipped.list   the files the last ship put here
```

`deployment.env` lives **next to `shop`**. `lib/common.sh` resolves it from its own directory and
refuses to run without it, so a copy in the wrong place fails at once.

Every `shop` command calls Compose the same way: the project `x-zoo`, `compose.yml`, then
every overlay `NEXT_COMPOSE_OVERLAYS` lists, and `deployment.env`. For anything else Compose can
do, go through `shop compose`, which calls it with exactly those:

```sh
cd /home/ubuntu/apps/X-ZOO
./shop compose ps
./shop compose logs -f worker web edge
```

Never call `docker compose` without them. Without `-p x-zoo` Compose names the project after
the directory, which is a _different_ project with different volumes: you would start a second,
empty stack beside the real one. Without the overlay an `up` recreates the edge off the router.

`REVISION` is written by `ship.sh`, and only after an upgrade passed, so it always names a commit
that came up. `shop status` prints it with the running digests.

## Releasing: `ship.sh`

On a machine with the repository, `gh` signed in, and SSH access to the host:

```sh
cp deploy/ship.local.env.example deploy/ship.local.env   # once: SHIP_HOST and SHIP_DIR

deploy/ship.sh                  # the tip of origin/master
deploy/ship.sh <commit>         # an earlier commit of master
deploy/ship.sh --dry-run        # everything up to the upgrade, and change nothing
```

`SHIP_HOST` is an SSH destination (`user@host`, or a `Host` alias) and `SHIP_DIR` the release
directory. Set in the environment, or given as `--host` and `--dir`, they win over the file.

### From GitHub, on approval

`.github/workflows/deploy.yml` runs the same `ship.sh` from GitHub after every passing push run of
master, once a reviewer of the `production` environment approves it (an e-mail and a GitHub Mobile
notification; Actions → the waiting run → **Review deployments**). Approving ships the newest master
commit whose push run passed, so merges can pile up and go out together: approve the newest
request and ignore or reject the older ones. A request that finds that commit already running ends
without touching the host. **Run workflow** on `Deploy to production` asks for a release by hand.

The `production` environment (Settings → Environments) admits `master` only and holds:

| Name                   | Kind     | Value                                                                                       |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `SHIP_SSH_KEY`         | secret   | a private key used for nothing else, its public half in the host's `~/.ssh/authorized_keys` |
| `SHIP_SSH_KNOWN_HOSTS` | secret   | the host's `known_hosts` lines (`ssh-keygen -F <host>` on a machine that trusts it)         |
| `SHIP_SSH_HOSTNAME`    | variable | the host's address                                                                          |
| `SHIP_SSH_USER`        | variable | the SSH user (`ubuntu`)                                                                     |
| `SHIP_SSH_PORT`        | variable | optional; 22                                                                                |
| `SHIP_DIR`             | variable | the release directory, `/home/ubuntu/apps/X-ZOO`                                            |

The host must accept SSH from GitHub's runners. A failed release fails the run (GitHub e-mails the
person who approved it) and prints `ship.sh status`; the exit codes below say what is left to do.
Without a reviewer on the environment every passing merge would ship by itself; the `pipeline`
guard refuses a deploy job without `environment: production`, not a reviewer list, so keep one.

Once the host runs the commit, the job `mini` builds the mini-program from that same commit against
the production API and uploads it to WeChat as CI robot 2's development version, version
`apps/mini/package.json`'s (`scripts/upload.mjs`, which checks the build the way §8 of
[device-check](../docs/mini/device-check.md) describes). The approval above covers it; the
`pipeline` guard refuses an upload job that does not need `ship`. Its settings are in a second
environment, `mini-trial`, which admits `master` only and needs no reviewer of its own:

| Name                 | Kind     | Value                                                                      |
| -------------------- | -------- | -------------------------------------------------------------------------- |
| `WX_MINI_UPLOAD_KEY` | secret   | the upload key's content (公众平台 → 开发管理 → 开发设置 → 小程序代码上传) |
| `MINI_API_ORIGIN`    | variable | the API origin the package calls, `https://<NEXT_HOST>`                    |

GitHub's runners have no fixed address, so the upload key's IP whitelist must be off. Pick robot 2's
version as 体验版 in 公众平台 → 版本管理 once; its later uploads replace it. A failed upload fails the
run after the release has gone out; **Run workflow** retries it without shipping again.

In order, refusing to continue when a step cannot be proven, it:

1. checks the commit is on `origin/master` and that CI's push run for it passed. A commit that
   changes only `docs/**` or `*.md` has no CI run and no images: ship the newest one CI built;
2. has the host resolve the three images CI published for it, `sha-<commit>`, to digests
   (`shop resolve`). Nobody copies a digest, and the upgrade is only ever given digests;
3. stages the runtime files, `git archive <commit> deploy` without the drill, the docs and
   `ship.sh`, on the host, prints what would change, and runs that staged `shop upgrade --dry-run`
   against the host's settings. `--dry-run` stops here;
4. syncs the files into the release directory. A file the last release shipped and this one does
   not is removed; `data/shipped.list` is what makes that exact. `deployment.env`, `data/` and
   `REVISION` are never touched;
5. runs `shop upgrade` for real, detached from the SSH session, with its output streamed and kept
   in `data/releases/<stamp>-<commit>.log`. A dropped connection cannot kill it halfway;
6. writes `REVISION`;
7. checks from outside: `https://<NEXT_HOST>/` (the landing page, answered by `web`) answers 2xx
   and `http://<NEXT_HOST>/` redirects to https. It reads that one setting with `shop hostname`, which prints it only while the
   Traefik overlay is applied.
8. checks the shop answers, read-only — GETs with no session, so nothing is written and no login
   attempt is spent: the storefront home page and product list answer 200, `/admin-api/auth/me`
   answers the app's own 401 `UNAUTHENTICATED` (not an edge 404 or 502), `/api/v1/readyz` is ok,
   and an effects backlog older than five minutes is reported as a warning.

| Exit | Meaning                                                                          |
| ---- | -------------------------------------------------------------------------------- |
| 0    | shipped                                                                          |
| 1    | the upgrade failed, and the previous images are running again                    |
| 2    | invoked wrongly                                                                  |
| 3    | the upgrade and its rollback failed, or the connection dropped: a person decides |
| 4    | refused before anything on the host changed                                      |
| 5    | deployed, but the site does not answer as it should from outside                 |

After a 1, the release directory holds the new files and the stack runs the previous images;
`REVISION` still names the previous release. Ship again once the cause is fixed, or ship the
previous commit to put its files back.

A release that changes only the Compose files, a label or a redirect, goes through the same
command. When its digests equal what runs, nothing is stopped, `APP_VERSION` keeps naming the
build that runs, and `up -d` recreates only what the files changed.

The same script forwards the host's everyday commands, so this machine is the one place anyone
types a command:

```sh
deploy/ship.sh status                     # shop status
deploy/ship.sh backup                     # shop backup
deploy/ship.sh rollback --last-upgrade    # shop rollback --last-upgrade
```

A tag is not a release. `shop upgrade` refuses anything that is not `repo@sha256:<64 hex>`: a tag
can be repointed between the run that passed and the deploy, and then the build that passed can no
longer be named. A rollback target has to be nameable.

## `shop` on the host

```sh
./shop help
./shop status                   # the release, the running digests, the last upgrade, the readiness gate
./shop upgrade  --web …@sha256:… --worker …@sha256:… --edge …@sha256:… [--app-version <commit>]
./shop rollback --last-upgrade
./shop backup
./shop resolve  <commit>        # the three digests CI published for a commit
./shop compose  <arguments>     # docker compose, with this deployment's project, files and settings
./shop hostname                 # NEXT_HOST, while the Traefik overlay is applied
```

`shop <command> --help` prints that command's contract, exit codes included. `ship.sh` is the
usual way to run `upgrade`; on the host it is there for a person who has to.

## Configuration: `deployment.env`

Every key the stack reads. `deployment.env.example` carries the same list with placeholders.

| Key                                                      | Meaning                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_WEB_IMAGE`, `NEXT_WORKER_IMAGE`, `NEXT_EDGE_IMAGE` | the release, as `repo@sha256:<64 hex>`. `shop upgrade` and `shop rollback` set these three; you only set them by hand once.                  |
| `NEXT_POSTGRES_IMAGE`, `NEXT_REDIS_IMAGE`                | the upstream images, also pinned by digest. Change them only as a deliberate upgrade of their own.                                           |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`      | the database role and name. Generate the password: `openssl rand -base64 24 \| tr -d /+=`.                                                   |
| `REDIS_PASSWORD`                                         | generated the same way.                                                                                                                      |
| `DATABASE_URL`, `REDIS_URL`                              | the same credentials spelled as URLs, with hosts `postgres` and `redis`. The application reads only these.                                   |
| `APP_ORIGIN`                                             | the origin the **browser** sees, e.g. `https://x-zoo.vip`. It drives the CSRF `Origin` check.                                                |
| `EXTRA_ALLOWED_ORIGINS`                                  | further origins allowed to send cookie-authenticated mutations, comma-separated. Usually empty.                                              |
| `APP_VERSION`                                            | the commit being served, reported by `/api/v1/health`. `shop upgrade --app-version` sets it, unless the images are the ones already running. |
| `LOG_LEVEL`                                              | pino level for `web` and `worker`; `info` by default.                                                                                        |
| `QUEUE_NAME`                                             | the BullMQ queue name; `shop`.                                                                                                               |
| `WORKER_CONCURRENCY`                                     | jobs one worker process runs at once; `4`.                                                                                                   |
| `WEB_DB_POOL_MAX`, `WORKER_DB_POOL_MAX`                  | connection pool sizes; `10` and `5`. Together they must stay under PostgreSQL's `max_connections=40`.                                        |
| `DB_POOL_ACQUIRE_TIMEOUT_MS`                             | how long a caller waits for a pooled connection before it errors instead of hanging; `5000`, `0` waits for ever.                             |
| `DB_IDLE_IN_TX_TIMEOUT_MS`                               | how long a session may sit idle inside an open transaction before PostgreSQL ends it and releases its locks; `30000`, `0` is off.            |
| `HEARTBEAT_INTERVAL_MS`                                  | how often the worker refreshes `worker:heartbeat`. `web` reads the same value to judge whether the heartbeat is fresh.                       |
| `NEXT_EDGE_BIND`                                         | where the edge publishes; `127.0.0.1:8080`. Keep it on loopback: Traefik reaches the edge over its own network.                              |
| `NEXT_HOST`                                              | the domain Traefik routes to the edge. Read by `compose.traefik.yml`, and by `shop hostname` for `ship.sh`.                                  |
| `NEXT_EDGE_TRUSTED_PROXIES`                              | the CIDRs whose `X-Forwarded-For` the edge believes: Traefik's network. Required by `compose.traefik.yml`; see below.                        |
| `NEXT_COMPOSE_OVERLAYS`                                  | the Compose files every script layers over `compose.yml`, relative to `shop`. Behind Traefik: `compose.traefik.yml`.                         |
| `NEXT_BACKUP_DIR`                                        | where dumps, upgrade manifests and settings backups go; `./data/backups`, relative to `shop`. Created mode 700.                              |
| `NEXT_DOMAIN_VERIFICATION_DIR`                           | the WeChat domain-verification files the edge serves at `/<name>.txt`; empty means `./data/domain-verification`, relative to `shop`.         |

`APP_ORIGIN` produces the most confusing failure in this list when it is wrong: every admin read
works and every admin _mutation_ returns 403.

Everything else the shop can be configured with (payment, SMS, storage, WeChat, logistics, the
site itself) is not an environment variable. It is typed configuration in the database, edited
under 设置 › 系统设置 in the admin.

Every `shop` command checks the file before it touches anything: it must exist, carry the image
and URL keys, be mode 600, and contain no `CHANGE-ME` placeholder. `shop status` is the quickest way
to run that check: on a host with nothing running it fails at the first readiness check, which
proves it got past the settings.

## First deploy on a new host

1. **Check the host has room.** At least 1.8 GB of memory free and 5 GB of disk:

   ```sh
   free -m; df -h /var/lib/docker
   ```

2. **Configure it.** From a machine with the repository:

   ```sh
   ssh <host> mkdir -p /home/ubuntu/apps/X-ZOO
   scp deploy/deployment.env.example <host>:/home/ubuntu/apps/X-ZOO/deployment.env
   ssh <host> chmod 600 /home/ubuntu/apps/X-ZOO/deployment.env
   ```

   Fill in the image repositories (any digest of the right repository will do; the ship replaces
   them), the two generated passwords (in both places each appears), `APP_ORIGIN` and `NEXT_HOST`.
   Leave `NEXT_COMPOSE_OVERLAYS` empty for now.

3. **Find Traefik's network.** The overlay joins the external network `server-internal-net`, which
   Traefik owns; it does not create it.

   ```sh
   docker network inspect server-internal-net \
     --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}'
   ```

   Put exactly that subnet (for example `172.18.0.0/16`) in `NEXT_EDGE_TRUSTED_PROXIES`.

4. **Bring the stack up**, with no route to it yet:

   ```sh
   deploy/ship.sh --first-deploy
   ```

   It ends with `readiness gate: passed`, `upgrade complete`, `rollback target: <none>` and
   `no public host name`. That `<none>` is correct here and only here: `--first-deploy` is the one
   run with nothing to go back to, and a failure leaves the stack down, which is harmless because
   nothing routes to it.

5. **Create the first super admin.** Nothing creates one on its own: the seed loads only
   reference data, and the admin cannot grant `is_super`. Generate a bcrypt hash from a checkout
   of the repository (the password is read from the terminal, not from the command line):

   ```sh
   cd packages/core
   read -rs PW && export PW
   node --input-type=module -e "import b from 'bcryptjs'; console.log(await b.hash(process.env.PW, 10))"
   unset PW
   ```

   Then insert the account on the host:

   ```sh
   ./shop compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
   insert into admins (account, password_hash, name, is_super)
   values ('admin', '<the hash>', '超级管理员', true);
   SQL
   ```

   Sign in at `/admin` and create every other account and role under 设置 › 管理员 and
   设置 › 身份管理.

6. **Smoke-test over loopback**, before anyone can reach it:

   ```sh
   ./shop status
   curl -fsS http://127.0.0.1:8080/healthz
   curl -fsS http://127.0.0.1:8080/readyz; echo
   curl -fsS http://127.0.0.1:8080/api/v1/health; echo
   curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/admin
   ```

   Expected: `readiness gate: passed`; `ok`; `{"status":"ok",…,"checks":{"database":"ok","redis":"ok","migrations":"ok","worker":"ok"}}`;
   `{"status":"ok","time":"…","version":"<commit>"}`; `200`. Through an SSH tunnel
   (`ssh -L 8080:127.0.0.1:8080 <host>`), sign in to the admin, upload an image and open it, and
   open `/`: the landing page with the shop's name.

7. **Put it behind Traefik**: set `NEXT_COMPOSE_OVERLAYS=compose.traefik.yml` and run
   `./shop compose up -d --wait` (next section). From then on every ship ends by checking the
   domain from outside.

8. **Watch** one full cycle of the repeatable jobs: `./shop compose logs -f worker web edge` and
   `docker stats --no-stream`. Expect no restarts and every container under its cap. An OOM kill
   shows up as a climbing restart count in `./shop compose ps`, not as an error in a log.

## The Traefik overlay

`compose.yml` carries no Traefik labels and no external network, so bringing the stack up can
never take the domain by accident. `compose.traefik.yml` adds both: the labels for `NEXT_HOST` on
the `web` and `websecure` entrypoints (certificate resolver `myresolver`), and the edge's second
network, `server-internal-net`.

The `web` (plain HTTP) router only redirects to HTTPS, permanently. It must never serve the site:
the session cookies are `Secure` in production, so on `http://` a browser takes the sign-in
response and drops its cookie, and the admin login appears to fail silently.

The `websecure` router accepts TLS 1.2 as well as 1.3: WeChat's mini-program network stack on iOS
does not speak TLS 1.3, so against a 1.3-only router every `wx.request` from an iPhone fails at the
handshake and never reaches the edge (Android and browsers still work, which hides it). The router
uses the TLS options `NEXT_TRAEFIK_TLS_OPTIONS`, default `default`: Traefik's own default set, which
on this host the shared Traefik's `dynamic_conf/tls.yml` defines as 1.2 minimum with ECDHE + AEAD
suites. A new host's Traefik must allow 1.2 in its `default`. Do not give the router a set of its
own instead: when a connection's SNI is not the router's host (a browser reusing a connection, a
proxy, a client without SNI), Traefik compares the two hosts' option sets and answers `421
Misdirected Request` if they differ, which took the admin down once. Check from outside with
`curl --tls-max 1.2 -sI https://<NEXT_HOST>/` and, without SNI,
`curl -skI -H 'Host: <NEXT_HOST>' https://<host IP>/` (expect `HTTP/2 200` from both).

The overlay is a setting of the deployment, not a step someone remembers. Name it in
`deployment.env`:

```sh
NEXT_COMPOSE_OVERLAYS=compose.traefik.yml
```

From then on every `shop` command calls Compose with `-f compose.yml -f compose.traefik.yml`, so
an upgrade or a rollback recreates the edge with its route, not without it. `shop` refuses to start
when the key names a file that does not exist. To apply it the first time, or after editing the
key, run an `up` through `shop`:

```sh
./shop compose up -d --wait
```

Then check the edge is on both networks:

```sh
docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(./shop compose ps -q edge)"
```

Expected: `x-zoo_default server-internal-net`. Run the same check after every upgrade and
rollback; the drill proves both keep the overlay, and this proves the host is configured to.

To take the site off the router, empty `NEXT_COMPOSE_OVERLAYS` and run the same `up`; the stack
keeps serving on loopback.

### The client's address

The edge is the one place that decides who is calling. It believes `X-Forwarded-For` only from
`NEXT_EDGE_TRUSTED_PROXIES`, takes the right-most address in it that is not Traefik's, and sends
the app that one address as both `X-Real-IP` and `X-Forwarded-For`, overwriting whatever the
client wrote. The app reads `X-Real-IP` only, and its port is never published, so every request
reaches it through the edge. The per-IP SMS budget, 访客数, `last_login_ip` and the audit log's IP
all rest on this.

Get the setting right. Too narrow, and every shopper arrives as Traefik's single address: the
per-IP SMS budget (50 codes a day by default) then locks the whole shop out of SMS sign-in within
the day. Too wide, and a caller can name its own address again; `0.0.0.0/0` is refused outright.
To check it, send a made-up header from outside and read what the edge logged:

```sh
curl -fsS -o /dev/null -H 'X-Forwarded-For: 198.51.100.77' 'https://<NEXT_HOST>/?ip-check'
./shop compose logs --since 1m edge | grep ip-check | tail -1
```

The line must start with **your** public address, not `198.51.100.77` and not an address inside
`NEXT_EDGE_TRUSTED_PROXIES`.

## Upgrade

`ship.sh` runs it. By hand, on the host:

```sh
./shop upgrade --app-version <commit> \
  --web    ghcr.io/xiangyu-labs/x-zoo-web@sha256:… \
  --worker ghcr.io/xiangyu-labs/x-zoo-worker@sha256:… \
  --edge   ghcr.io/xiangyu-labs/x-zoo-edge@sha256:…
```

All three images, always. A release where `web` moved and `worker` did not is a web talking to a
worker built against a different contract.

In order, refusing to continue when a step cannot be proven, it:

1. checks all three candidates are digests and records the running images as the rollback target;
2. pulls the candidates **before** anything is stopped;
3. asks the candidate worker image, read-only, which migrations the database has not applied
   (`db/src/pending.mjs`);
4. takes one of two paths:
   - **migrations pending**: stops `web`, `worker` and `edge`, so a migration never runs against
     live writers; takes a dump and proves it restorable; runs the migrations and the reference
     seed as the `migrate` one-shot; starts the candidates. The site is down from the stop to the
     readiness gate. A first deploy, or a candidate that cannot answer the question, takes this
     path too;
   - **nothing to migrate**: stops nothing. It still takes the dump and proves it; runs the
     reference seed beside the live stack; and recreates only the services whose image or
     configuration changed, one at a time, `web` first and the edge last. The edge finds the new
     `web` by name through Docker's DNS, so the edge keeps answering throughout and the app
     is out of reach only while `web` restarts: 1.4 to 1.7 s in the drill, against 11 to 13 s for a
     release that migrates;
5. runs the readiness gate.

If anything after the candidates are pinned fails, it puts the previous images back and says
whether the schema had moved. The migrations are additive, so the previous images run on the new
schema; CI refuses a migration that is not. It never restores data on its own.

**Why the seed may run beside live traffic.** Every statement in it is an upsert on a natural key,
inside one transaction, and it touches only reference tables (cities, express companies, agreement
and notification shells). It never deletes or truncates. Readers do not wait on it; a write to one
of the same rows waits for its commit, a few seconds at most.

| Exit | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| 0    | deployed                                                |
| 1    | failed, and the previous images are running again       |
| 2    | invoked wrongly                                         |
| 3    | failed, **and** the rollback failed: a person is needed |

`--dry-run` checks, pulls and asks about migrations, prints the path the release would take (`the
release would stop nothing`, or `would stop web, worker and edge to migrate`), and stops before
touching anything. `--skip-migration` deploys images only, runs neither the migrations nor the
seed, and so stops nothing. Each run writes `data/backups/upgrade-<stamp>.manifest` with the
previous and new images and release, the pending migrations, the path taken, the dump, and the
outcome; `shop status` prints the last one.

## Rollback

```sh
deploy/ship.sh rollback --last-upgrade      # from the machine with the repository
./shop rollback --last-upgrade              # on the host: the images the last upgrade replaced
./shop rollback --web …@sha256:… --worker …@sha256:… --edge …@sha256:…
```

It checks the target images exist (pulling them if needed) before it changes anything, switches,
and runs the readiness gate. If the target does not come up, it returns to what was running.
`--last-upgrade` also puts `REVISION` back to the release that upgrade replaced.

| Exit | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| 0    | rolled back                                                        |
| 1    | the target did not come up; the previously running images are back |
| 2    | invoked wrongly                                                    |
| 3    | a person is needed                                                 |

Replacing containers never changes data. Like `upgrade`, it uses the overlays in
`NEXT_COMPOSE_OVERLAYS`, so the edge keeps its route. A rollback returns the images, not the
Compose files: to return those too, ship the previous commit.

## Backup and restore

Every upgrade but the first takes a verified dump. To take one at any other time:

```sh
./shop backup                               # into NEXT_BACKUP_DIR, then verify it
./shop backup --out /somewhere/shop.sql.gz
./shop backup --verify-only data/backups/pre-upgrade-<stamp>.sql.gz
```

Verification restores the dump into a throwaway PostgreSQL with no network and its data on tmpfs,
then checks every table in `public`:

- against the rows the dump itself carries, always: every row it holds must come back;
- against the live database, when `web` and `worker` are stopped, as during a release that
  migrates, and for `--verify-only`: the dump must hold every row there is.

While the writers run, live row counts move under the comparison, so the second check becomes
"the dump has every table the live database has". `pg_dump` reads one consistent snapshot either
way, which is what makes a dump taken beside live traffic a valid way back. It prints
`backup verified: <n> table(s) restored with matching row counts`. "The dump exists" and "the dump
is usable" are different claims; only the second is worth a release waiting for. `--no-verify`
exists for a scheduled dump on a host short of memory. Nothing here schedules backups; add a cron
entry if you want them, and copy dumps off the host.

To restore a dump over the live database:

```sh
./shop rollback --last-upgrade --restore data/backups/pre-upgrade-<stamp>.sql.gz
```

`--restore` is never implied. It stops the writers, takes a safety dump of what it is about to
overwrite, asks you to type `restore` (or takes `--yes`), restores, and runs the readiness gate.
Every row written since the dump is gone.

**Uploads are not in the dump.** They live in the volume `x-zoo_uploads`. Back them up
separately:

```sh
docker run --rm -v x-zoo_uploads:/data:ro -v "$PWD":/out alpine \
  tar -czf /out/uploads-$(date +%Y%m%d).tar.gz -C /data .
```

When you restore files into the volume by hand, make them readable afterwards:

```sh
docker run --rm -v x-zoo_uploads:/data alpine chmod -R a+rX /data
```

The edge serves uploads as nginx's unprivileged user. A directory left at `0700` by whatever wrote
it turns every image under it into a 404, with `(13: Permission denied)` in the edge log. `a+rX`
sets `+x` on directories only, so no uploaded file becomes executable.

## What the edge sends to `web`

The edge proxies `/` (exactly), `/admin`, `/admin-api`, `/api`, `/scan-upload` and
`/_next/static/` to `web`, and `/readyz` to the app's `/api/v1/readyz`. It also proxies exactly
`/favicon.ico`, `/icon.svg` and `/robots.txt`, which `web` answers from `apps/web/public` and
`apps/web/app`: the icon
every page links (the admin's too) and a `robots.txt` of `User-agent: *` / `Disallow: /`. It serves
`/uploads/` and the verification files (next section) itself. Every other path is a `302` to `/`
with a relative `Location: /`: an old H5 or share link lands on the landing page, which shows the
shop's name and the 小程序码. There is no storefront on the web; the shop is the WeChat
mini-program. The landing page keeps the root layout's `noindex`, and `robots.txt` says the same to
crawlers.

So a Next page the edge does not proxy never 404s: it turns into that redirect, which is easy to
miss. A new page or route handler under `apps/web/app` outside those prefixes therefore needs a
location in `docker/edge/nginx.conf`, with the same `X-Real-IP` and `X-Forwarded-For` handling as
the others. So does a new file-convention icon (an `apple-icon.png`, say): it is not a page, and
the edge proxies only the icon paths it names. The drill case `edge/proxies-every-page-route`
requests every page route (`/` included) and one route handler per top-level path through the real
edge, and fails on any that comes back as the edge's redirect to `/`; it also requires
`/favicon.ico` and every icon linked from `/` and `/admin/login` to come back as an image.

## Domain verification files

The shop's domain is a WeChat 业务域名 (web-view pages of the shop open inside the mini-program,
docs/mini/wechat-compliance.md C12). WeChat checks it by fetching a file it hands out,
`https://<NEXT_HOST>/<name>.txt`, from the root of the domain. The edge serves any root-level
`/<name>.txt` whose name is letters, digits, `_` and `-` from a host directory mounted read-only
into it, never from the app:

- the directory is `NEXT_DOMAIN_VERIFICATION_DIR`, by default `data/domain-verification/` beside
  `shop` (`/home/ubuntu/apps/X-ZOO/data/domain-verification/`). No release touches `data/`, so a
  file placed there survives every ship and rollback;
- `shop upgrade` creates it (mode 755) when it does not exist, so Docker never creates it as root.

To add a file, download it from 公众平台 → 开发管理 → 开发设置 → 业务域名, then from the machine with the
repository:

```sh
scp <name>.txt <host>:/home/ubuntu/apps/X-ZOO/data/domain-verification/
ssh <host> chmod 644 /home/ubuntu/apps/X-ZOO/data/domain-verification/<name>.txt
curl -fsS https://<NEXT_HOST>/<name>.txt; echo     # prints the file's content
```

No restart is needed: nginx reads the file on each request. Then add the domain in the 公众平台 and
keep the admin's 微信小程序 → 业务域名 list the same (CLIENT-002). The file must be readable by
everyone (`644`): nginx's workers are not the host user. A name that is not there is a `404`, not
the redirect, and a `.txt` anywhere but the root is not served from the directory. Leave the file
in place: WeChat may check it again. `/robots.txt` is the one name never served from the
directory: `web` answers it, and a `robots.txt` put there is ignored.

## Health and readiness

- `/healthz` is nginx answering for itself. It never depends on the app, so a slow app cannot
  take the edge's own probe down with it.
- `/api/v1/health` is the app answering, shallowly. It carries the version and no dependency
  detail.
- `/readyz` is proxied to the app's `/api/v1/readyz`, the deep check: database, Redis, migrations
  and worker heartbeat. The worker check needs both beats: `worker:heartbeat` (the process is
  alive) and `worker:heartbeat:job`, written when a job completes, no older than three minutes
  (`JOB_HEARTBEAT_MAX_AGE_MS`), so a worker whose queue consumer is stuck is not ready. It
  answers 503 naming the check that failed, and nothing else: no error text, no host, no
  connection string. The detail is in `./shop compose logs web`.

The container healthchecks use only the shallow probes. A container probe that opens a database
connection restarts the container whenever the database blips, which turns a degradation into an
outage. Nothing restarts a container on `/readyz`; an uptime monitor reads it, and so does the
**readiness gate** (`lib/readiness.sh`, which `shop status` runs on its own) that ends every
upgrade and rollback: every container healthy, both HTTP probes answering through the published
port, the migrations applied with the tables the release needs, and a fresh `worker:heartbeat`.

The worker has no HTTP surface, so its probe reads `worker:heartbeat` and requires it to be
**recent**. The key is refreshed from the same event loop that runs the jobs and dropped before
draining on SIGTERM, so a wedged worker turns unhealthy, not merely a dead one.

## Where uploads are served from

With the local storage driver, the edge serves uploads under `/uploads/`: the **same origin** as
the admin and the API. That is a decision:

- a second hostname for uploads needs its own DNS, certificate and ICP filing;
- the uploader refuses HTML, SVG, XML, scripts and executables by content, not by name, and stores
  the sniffed type;
- the edge serves every upload with `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`, and `Content-Disposition: attachment` for
  everything but images and video. A file that did slip through downloads, or renders with no
  script and no origin, instead of running beside an admin session.

Revisit it the day either of the first two stops holding, and in particular before any change that
lets SVG or HTML in. With the S3 driver the same rule applies to `s3PublicBaseUrl`: point it at a
bucket or CDN hostname, never at this site's own origin, and give that host the same three headers.

## Memory

The host has 2 cores and 3.6 GB. The five long-running services are capped at 1568 MiB in total.
When a release migrates, `migrate` (384 MiB) runs while `web` and `worker` are stopped, reusing
their 832 MiB. When nothing migrates, it runs the seed beside them, for 1952 MiB in total; the
drill holds that under 2048 MiB. The dump's restore check adds a PostgreSQL with its data on a
512 MiB tmpfs for the minute it runs. Each JavaScript service also sets `--max-old-space-size`,
because V8 sizes its heap from the _host's_ memory and would otherwise be OOM-killed with no
diagnostic.

## Behaviour an admin may ask about

- **售后设置** (the return address) needs the `refund:config:write` permission. A super admin
  holds every permission; a narrower role must be granted it.
- **店员 approving or rejecting a refund** is off until 允许店员审核售后 is turned on (店员与订单提醒 ›
  店员). List, detail and 备注 work without it.
- **网址导入** accepts `https://` sources only, unless 允许 http 地址导入 is turned on (存储设置 ›
  网址导入). Private, loopback and cloud-metadata addresses are always refused.
- **操作日志** lists every admin sign-in, successful or not, and every 店员 write, as well as admin
  writes.
- **浏览量** is folded into `products.views` once a minute by the worker, from a watermark kept in
  Redis. If Redis loses the watermark, the next run starts from the newest view, and the views in
  between are not added to the displayed counter; the view events the reports read are untouched.

## The drill

```sh
deploy/rehearsal/drill.sh                    # every case; about 10 minutes, half an hour from a cold build cache
deploy/rehearsal/drill.sh --list             # the case ids
deploy/rehearsal/drill.sh --shards           # the groups CI runs side by side
deploy/rehearsal/drill.sh --parallel         # every shard side by side, images built once, as CI does
deploy/rehearsal/drill.sh --shard ship       # one group (add --list for its cases)
deploy/rehearsal/drill.sh --only ship --keep
```

It builds the three images from the checkout, pushes them to a registry container it starts, and
then deploys, breaks and rolls back a real stack: a moving tag, a missing candidate, a dry run, a
tampered and a truncated dump, a dump taken under live writes, a failing migration, a worker that
starts and does no work, a readiness gate that finds a table missing, a rollback to an image that
is not there, a successful upgrade and rollback, the same with an overlay configured (a stand-in
for `compose.traefik.yml` on a stand-in network, never the real one), a release with nothing to
migrate (with a probe measuring the longest gap in answers), one that changes only the Compose
files, one with a new migration, a Next page or icon the edge would not proxy, and a verification file
placed in the mounted directory (and a `robots.txt` there, which must lose to `web`'s). Its `ship/` cases run
`ship.sh` with `SHIP_HOST=local` into a directory of their own, against a stand-in `gh`: a red CI,
a dry run, a fresh directory, a release that drops a file, and the forwarded commands. They ship
`HEAD`, so commit first.

It uses its own Compose project (`x-zoo-drill`, or `x-zoo-drill-<shard>` for one shard), its own
generated passwords under `$TMPDIR` and its own free loopback port, so it can run beside the live
stack. It needs the whole repository, not just `deploy/`. CI runs it in the merge queue, one
runner per shard.

The cases form chains (a rollback needs the upgrade before it), so each is in one shard, a chain
with a stack of its own; `CASE_SHARDS` in the script says which, and the script refuses to start
if a case has none. A shard names its project, containers, registry, overlay network and derived
image tags after itself and takes ports from a range of its own, so shards can run side by side.
CI builds the images once and gives every shard the same ones (`--no-build --web … --worker …
--edge …`), and the `pipeline` guard holds that the workflow runs every shard the script names.
`--parallel` does the same on one machine: it builds the three images at once, starts every shard
with them (`--jobs N` caps how many run together), writes each shard's output to a log of its own
and ends with each shard's time and result, and the tail of a failed one's log. Each shard is a
full stack under its Compose memory limits (about 1.6 GiB each at most), so on a busy machine
lower `--jobs`; the three image builds at the start are the heavier part. `unhealthy` is the
longest shard (it waits out the worker's real healthcheck) and sets the time of the job.

## Rules

- Every image is pinned by digest. `shop upgrade` refuses a moving tag, and `ship.sh` passes
  digests only.
- No credential reaches a command line. Each is expanded by the shell inside the container that
  needs it, from that container's own environment.
- `docker compose down -v` deletes the volumes. It is never run against `x-zoo`.
- Images are built in CI, not on the host: a 2-core box cannot spare the cores and does not need
  a toolchain.
