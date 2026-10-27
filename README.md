# apt-repo-docker

A self-hosted, GPG-signed Debian APT repository in one container, with a web UI to manage packages.

- **[aptly](https://www.aptly.info/)** stores packages, signs and publishes the repository, and provides a REST API.
- **nginx** serves the published repository at `/`, the management UI at `/ui/`, and the aptly API at `/api/`.
  Basic auth protects the API. The UI has its own sign-in form and passes the login on to the API.
- **Web UI** is a small dependency-free page. It can:
  - upload `.deb`s by drag and drop
  - search, sort, inspect and remove packages
  - prune old versions
  - copy (promote) packages between repositories
  - create repositories
  - take snapshots and restore from them
  - republish and clean up storage
  - show ready-to-paste client setup

Everything persists in a single `/data` volume (aptly database, package pool, published tree and signing key).

## Quick start

```sh
docker build -t apt-repo .            # podman: podman build --format docker -t apt-repo .
docker run -d --name apt-repo -p 8080:80 \
  -e ADMIN_PASSWORD=change-me \
  -e REPO_DISTRIBUTIONS="trixie bookworm" \
  -v apt-data:/data \
  apt-repo
```

Or use `docker compose up -d` (also works with `podman compose`). Then:

- UI: <http://localhost:8080/ui/>. Sign in as `admin` with your `ADMIN_PASSWORD`.
- Repository: <http://localhost:8080/>
- Public key: <http://localhost:8080/repo.gpg>

On first start the container generates an RSA 4096 signing key. It then creates one repository per
distribution, named `<dist>-main`, and publishes each one as an empty signed distribution. If you
don't set `ADMIN_PASSWORD`, a random one is generated, printed once in the logs, and kept in the volume.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / generated | Login for `/ui/` and `/api/` |
| `REPO_DISTRIBUTIONS` | `trixie` | Space/comma-separated distributions to create on first start |
| `REPO_COMPONENT` | `main` | Component for those repositories |
| `REPO_ARCHITECTURES` | `amd64,arm64` | Architectures to publish (`all` packages are included automatically) |
| `REPO_ORIGIN` / `REPO_LABEL` | `apt-repo` | `Origin:` / `Label:` fields in the Release file |
| `GPG_NAME` / `GPG_EMAIL` | generic | Identity of the generated signing key |
| `GPG_KEY_FILE` | `/run/secrets/repo-signing-key` | If this file exists, it's imported and used for signing instead of generating a key. It must be a passphrase-less secret key. |
| `REPO_READ_USER` / `REPO_READ_PASSWORD` | unset | Makes the repository private: apt clients must log in. `repo.gpg` stays public. |

If you change the signing key later (for example by mounting your own), the container re-signs all
published distributions on the next start.

Put the container behind your existing reverse proxy (Caddy, Traefik, nginx) for HTTPS. The UI
builds client instructions from the URL you open it at, so open it through the public URL.

## Using the repository on a client

The UI's **Client setup** page generates these commands for your server and distributions:

```sh
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://apt.example.com/repo.gpg | sudo tee /etc/apt/keyrings/apt-repo.gpg > /dev/null

sudo tee /etc/apt/sources.list.d/apt-repo.sources > /dev/null <<'EOF'
Types: deb
URIs: https://apt.example.com
Suites: trixie
Components: main
Signed-By: /etc/apt/keyrings/apt-repo.gpg
EOF
sudo apt update
```

For a private repository, also add `/etc/apt/auth.conf.d/apt-repo.conf` (mode 600):

```
machine apt.example.com
login <REPO_READ_USER>
password <REPO_READ_PASSWORD>
```

## Uploading from CI

`scripts/apt-upload.sh` uploads files, adds them to a repository, and republishes every distribution
that serves it. It needs `curl` and `jq`, and exits non-zero if any file was rejected.

```sh
export APT_REPO_URL=https://apt.example.com APT_REPO_USER=admin APT_REPO_PASSWORD=...
./scripts/apt-upload.sh trixie-main build/*.deb
```

The same thing with plain curl against the aptly API:

```sh
curl -u admin:PW -F file=@pkg.deb            https://apt.example.com/api/files/ci-123
curl -u admin:PW -X POST                     https://apt.example.com/api/repos/trixie-main/file/ci-123
curl -u admin:PW -X PUT -H 'Content-Type: application/json' -d '{"Signing":{"Batch":true}}' \
     https://apt.example.com/api/publish/:./trixie
```

## Operations

- **aptly CLI:** run it inside the container as the `aptly` user, for example
  `docker exec -u aptly apt-repo aptly -config=/etc/aptly.conf repo list`. The API runs with
  `-no-lock`, so the CLI and the API can be used side by side.
- **Backup:** back up the `/data` volume. It holds everything, including the signing key in
  `/data/gnupg`. Also keep an offline copy of the key:
  `docker exec -u aptly apt-repo gpg --armor --export-secret-keys > signing-key.asc`.
- **Disk space:** removing packages doesn't delete their files right away. Run **Clean up storage**
  in the UI (`POST /api/db/cleanup`) to delete files that no repository or snapshot references.
- **Health:** the image has a `HEALTHCHECK` (podman needs `--format docker` at build time to keep it).
  nginx also answers `GET /healthz`.

## Recommendations for managing your packages

1. **Use channels.** Keep one repository per distribution and channel, for example `trixie-main`
   (stable) and `trixie-testing`. Publish each as its own suite. Upload new builds to testing, then
   use **Copy to…** to promote the exact same files to stable once they're verified. Never rebuild for
   stable.
2. **Let CI publish and use the UI to manage.** Pipelines should call `apt-upload.sh` with a dedicated
   credential. The UI is for inspecting, pruning, promoting, rolling back and hotfixes.
3. **Never reuse a version number.** aptly rejects a package that has the same name, version and
   architecture but different contents. That's on purpose, because clients cache by version. Bump
   the version instead, for example `1.4.2-1+build57` or `1.5.0~rc1-1`. The "Replace conflicting
   packages" option exists only for emergencies.
4. **Protect the signing key.** It's the root of trust for every client. Back it up offline, use
   a dedicated key per repository, and pin it on clients with `Signed-By:`. Don't use the deprecated
   `apt-key` or `trusted.gpg.d`, which make the key valid for all repositories.
5. **Snapshot before big changes.** A snapshot is a cheap, frozen package list. **Restore…** puts a
   repository back exactly as it was and republishes it.
6. **Prune regularly.** Keeping the last 3–5 versions of each package is usually enough for
   rollbacks. Use **Prune old versions**, then **Clean up storage**.
7. **Know when to switch tools.** If you need per-team permissions, audit logs or many package
   formats in one place, look at Pulp (`pulp_deb`), Sonatype Nexus or Artifactory. If you already
   run Forgejo or Gitea, its built-in Debian package registry is a maintenance-free alternative.

## Layout

```
Dockerfile              debian:trixie-slim + aptly + nginx + tini
docker/entrypoint.sh    first-boot bootstrap (key, auth, repos) and process supervision
docker/aptly.conf       aptly config template (architectures filled in at start)
docker/nginx.conf       repository, UI and API routing
web/                    management UI (static HTML/CSS/JS)
scripts/apt-upload.sh   CI upload helper
docker-compose.yml      example deployment
```
