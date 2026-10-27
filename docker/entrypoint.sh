#!/usr/bin/env bash
# Bootstraps the aptly repository on first start, then runs the aptly API and nginx.
set -euo pipefail

: "${ADMIN_USER:=admin}"
: "${ADMIN_PASSWORD:=}"
: "${REPO_READ_USER:=}"
: "${REPO_READ_PASSWORD:=}"
: "${REPO_DISTRIBUTIONS:=trixie}"
: "${REPO_COMPONENT:=main}"
: "${REPO_ARCHITECTURES:=amd64,arm64}"
: "${REPO_ORIGIN:=apt-repo}"
: "${REPO_LABEL:=apt-repo}"
: "${GPG_NAME:=APT Repository Signing Key}"
: "${GPG_EMAIL:=apt-repo@localhost}"
: "${GPG_KEY_FILE:=/run/secrets/repo-signing-key}"

DATA_DIR=/data
PUBLIC_DIR=$DATA_DIR/aptly/public
UI_DIR=/usr/share/apt-ui
ADMIN_PW_FILE=$DATA_DIR/.admin-password
FPR_FILE=$DATA_DIR/.signing-key-fpr
export GNUPGHOME=${GNUPGHOME:-$DATA_DIR/gnupg}

log() { printf '[entrypoint] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
as_aptly() { setpriv --reuid=aptly --regid=aptly --init-groups -- "$@"; }
aptly_cli() { as_aptly aptly -config=/etc/aptly.conf "$@"; }
json_str() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }
hash_password() { printf '%s\n' "$1" | openssl passwd -6 -stdin; }
# Fingerprint of the first secret key in the colon-formatted gpg output on stdin.
first_fpr() { awk -F: '$1=="sec"{s=1; next} s && $1=="fpr"{print $10; exit}'; }

# --- data volume ---------------------------------------------------------------
if [[ $(stat -c %u "$DATA_DIR") != "$(id -u aptly)" ]]; then
  log "Fixing ownership of $DATA_DIR"
  chown -R aptly:aptly "$DATA_DIR"
fi
as_aptly mkdir -p "$PUBLIC_DIR" "$GNUPGHOME"
chmod 700 "$GNUPGHOME"

# --- aptly config --------------------------------------------------------------
IFS=', ' read -r -a ARCHS <<<"$REPO_ARCHITECTURES"
(( ${#ARCHS[@]} )) || die "REPO_ARCHITECTURES is empty"
ARCH_CSV=$(IFS=,; echo "${ARCHS[*]}")
ARCH_JSON=$(printf '"%s",' "${ARCHS[@]}")
ARCH_JSON="[${ARCH_JSON%,}]"
sed "s|__ARCHITECTURES__|$ARCH_JSON|" /etc/aptly.conf.tmpl >/etc/aptly.conf

# --- signing key -----------------------------------------------------------------
if [[ -f $GPG_KEY_FILE ]]; then
  log "Importing signing key from $GPG_KEY_FILE"
  as_aptly gpg --batch --import <"$GPG_KEY_FILE"
  SIGNING_FPR=$(as_aptly gpg --batch --with-colons --import-options show-only --import <"$GPG_KEY_FILE" | first_fpr)
elif [[ -z $(as_aptly gpg --batch --with-colons --list-secret-keys 2>/dev/null | first_fpr) ]]; then
  log "Generating a new RSA 4096 signing key for '$GPG_NAME <$GPG_EMAIL>'"
  as_aptly gpg --batch --pinentry-mode loopback --passphrase '' \
    --quick-gen-key "$GPG_NAME <$GPG_EMAIL>" rsa4096 sign never
fi
SIGNING_FPR=${SIGNING_FPR:-$(as_aptly gpg --batch --with-colons --list-secret-keys | first_fpr)}
[[ -n $SIGNING_FPR ]] || die "no usable secret key found (is the key file a passphrase-less secret key?)"

# aptly signs with gpg's default key, so pin it in case the keyring holds several.
printf 'default-key %s\n' "$SIGNING_FPR" | as_aptly tee "$GNUPGHOME/gpg.conf" >/dev/null
as_aptly gpg --batch --export "$SIGNING_FPR" >"$PUBLIC_DIR/repo.gpg"
as_aptly gpg --batch --armor --export "$SIGNING_FPR" >"$PUBLIC_DIR/repo.asc"
log "Signing key fingerprint: $SIGNING_FPR"

# --- HTTP auth -----------------------------------------------------------------
[[ $ADMIN_USER != *:* ]] || die "ADMIN_USER must not contain ':'"
if [[ -z $ADMIN_PASSWORD ]]; then
  if [[ -s $ADMIN_PW_FILE ]]; then
    ADMIN_PASSWORD=$(<"$ADMIN_PW_FILE")
  else
    ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
    (umask 077; printf '%s\n' "$ADMIN_PASSWORD" >"$ADMIN_PW_FILE")
    log "Generated admin password for '$ADMIN_USER': $ADMIN_PASSWORD"
    log "(stored in $ADMIN_PW_FILE; set ADMIN_PASSWORD to choose your own)"
  fi
fi

install -m 640 -g www-data /dev/null /etc/nginx/htpasswd-admin
printf '%s:%s\n' "$ADMIN_USER" "$(hash_password "$ADMIN_PASSWORD")" >/etc/nginx/htpasswd-admin

mkdir -p /etc/nginx/snippets
if [[ -n $REPO_READ_USER ]]; then
  [[ $REPO_READ_USER != *:* ]] || die "REPO_READ_USER must not contain ':'"
  [[ -n $REPO_READ_PASSWORD ]] || die "REPO_READ_PASSWORD is required when REPO_READ_USER is set"
  install -m 640 -g www-data /dev/null /etc/nginx/htpasswd-read
  {
    cat /etc/nginx/htpasswd-admin
    printf '%s:%s\n' "$REPO_READ_USER" "$(hash_password "$REPO_READ_PASSWORD")"
  } >/etc/nginx/htpasswd-read
  printf 'auth_basic "APT repository";\nauth_basic_user_file /etc/nginx/htpasswd-read;\n' \
    >/etc/nginx/snippets/repo-auth.conf
  log "Repository is private (read user: $REPO_READ_USER)"
else
  : >/etc/nginx/snippets/repo-auth.conf
fi

# Static settings for the web UI (served behind the admin login).
cat >"$UI_DIR/info.json" <<EOF
{
  "fingerprint": "$SIGNING_FPR",
  "origin": $(json_str "$REPO_ORIGIN"),
  "label": $(json_str "$REPO_LABEL"),
  "architectures": $ARCH_JSON,
  "private": $([[ -n $REPO_READ_USER ]] && echo true || echo false),
  "readUser": $(json_str "$REPO_READ_USER")
}
EOF

# --- repositories ----------------------------------------------------------------
# Done with the CLI before the API starts, so nothing else holds the database.
IFS=', ' read -r -a DISTS <<<"$REPO_DISTRIBUTIONS"
for dist in "${DISTS[@]}"; do
  repo="$dist-$REPO_COMPONENT"
  if ! aptly_cli repo show "$repo" >/dev/null 2>&1; then
    log "Creating repository $repo"
    aptly_cli repo create -comment="Packages for $dist" \
      -distribution="$dist" -component="$REPO_COMPONENT" "$repo" >/dev/null
  fi
  if ! aptly_cli publish list -raw | grep -qxF ". $dist"; then
    log "Publishing $repo as distribution $dist"
    aptly_cli publish repo -batch -architectures="$ARCH_CSV" \
      -origin="$REPO_ORIGIN" -label="$REPO_LABEL" "$repo" >/dev/null
  fi
done

PREV_FPR=$(cat "$FPR_FILE" 2>/dev/null || true)
if [[ -n $PREV_FPR && $PREV_FPR != "$SIGNING_FPR" ]]; then
  log "Signing key changed; re-signing published repositories"
  while read -r prefix dist; do
    aptly_cli publish update -batch "$dist" "$prefix" >/dev/null \
      || log "WARNING: could not re-sign $prefix/$dist"
  done < <(aptly_cli publish list -raw)
fi
printf '%s\n' "$SIGNING_FPR" >"$FPR_FILE"

# --- services ----------------------------------------------------------------------
nginx -t -q
log "Starting aptly API and nginx"
as_aptly aptly -config=/etc/aptly.conf api serve -listen=127.0.0.1:8080 -no-lock &
aptly_pid=$!
nginx -g 'daemon off;' &
nginx_pid=$!

stopping=0
shutdown() {
  stopping=1
  kill -TERM "$aptly_pid" "$nginx_pid" 2>/dev/null || true
}
trap shutdown TERM INT

status=0
wait -n "$aptly_pid" "$nginx_pid" || status=$?
if (( stopping )); then
  status=0
else
  log "A service exited unexpectedly (status $status); stopping the container"
  (( status )) || status=1
fi
shutdown
wait || true
exit "$status"
