#!/usr/bin/env bash
# Upload package files to the APT repository, add them to a repo, and republish it.
#
# Usage: apt-upload.sh [-f] <repo> <file>...
#   -f  replace packages that conflict (same name/version/arch, different contents)
#
# Environment:
#   APT_REPO_URL       base URL of the server, e.g. https://apt.example.com
#   APT_REPO_USER      admin user (default: admin)
#   APT_REPO_PASSWORD  admin password
#
# Requires curl and jq.
set -euo pipefail

usage() { sed -n '2,12s/^# \{0,1\}//p' "$0" >&2; exit 2; }
die() { echo "apt-upload: $*" >&2; exit 1; }

force=
while getopts fh opt; do
  case $opt in
    f) force='?forceReplace=1' ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))
(( $# >= 2 )) || usage
repo=$1
shift

: "${APT_REPO_URL:?set APT_REPO_URL}"
: "${APT_REPO_PASSWORD:?set APT_REPO_PASSWORD}"
command -v jq >/dev/null || die "jq is required"
base=${APT_REPO_URL%/}/api

# Credentials go through a curl config file descriptor so they don't show up in `ps`.
creds=$(printf '%s:%s' "${APT_REPO_USER:-admin}" "$APT_REPO_PASSWORD" | sed 's/[\\"]/\\&/g')
api() { curl -sS --fail-with-body -K <(printf 'user = "%s"\n' "$creds") "$@"; }

form=()
for f in "$@"; do
  [[ -f $f ]] || die "no such file: $f"
  form+=(-F "file=@$f")
done

dir="ci-$(date +%Y%m%d%H%M%S)-$$"
trap 'api -X DELETE "$base/files/$dir" >/dev/null 2>&1 || true' EXIT

echo "Uploading $# file(s) to $repo..."
api -X POST "${form[@]}" "$base/files/$dir" >/dev/null
result=$(api -X POST "$base/repos/$repo/file/$dir$force")

jq -r '(.Report // {}) as $r
  | ($r.Added // [] | .[] | "  added:    " + .),
    ($r.Removed // [] | .[] | "  replaced: " + .),
    ($r.Warnings // [] | .[] | "  warning:  " + .)' <<<"$result"
changed=$(jq '(.Report.Added // []) + (.Report.Removed // []) | length' <<<"$result")
failed=$(jq '.FailedFiles // [] | length' <<<"$result")

if (( changed > 0 )); then
  # Republish every distribution that publishes this repo. aptly encodes the
  # prefix in URLs: "." -> ":.", "_" -> "__", "/" -> "_".
  api "$base/publish" | jq -r --arg repo "$repo" '.[]
    | select(.SourceKind == "local" and any(.Sources[]; .Name == $repo))
    | [(if .Prefix == "." then ":." else (.Prefix | gsub("_"; "__") | gsub("/"; "_")) end), .Distribution]
    | @tsv' |
    while IFS=$'\t' read -r prefix dist; do
      echo "Publishing $dist..."
      api -X PUT -H 'Content-Type: application/json' -d '{"Signing":{"Batch":true}}' \
        "$base/publish/$prefix/$dist" >/dev/null
    done
fi

(( failed == 0 )) || die "$failed file(s) failed to import (see warnings above)"
echo "Done."
