#!/bin/sh
# Installs the runtime baked into this image into Xodus Nexus's runtime root and
# points Nexus at it, as Nexus's own installer does: the tree goes to
# <root>/releases/<name>, then current.json (which Nexus reads at start) names its
# wine. Runs as direwolf's initContainer on the shared home before every Nexus
# session, so the fork's runtime replaces whatever upstream runtime was installed.
#
# Copies only when the release is missing; a re-run with the same image is a no-op.
# On a switch, releases this script installed earlier are pruned, except the one
# current.json named until now (a running session may still read it); upstream
# installs are never touched.
#
# No lock: several sessions may start at once, and a run may be killed at any
# point. Each run copies into its own staging directory and publishes with one
# rename, so a release with the marker is always whole and a second, losing
# rename only discards a duplicate.
set -eu

src_root=${RUNTIME_SOURCE:-/runtime}
root=${XODUS_RUNTIME_ROOT:-/config/.local/share/xodus-nexus/runtimes}
marker=.direwolf-runtime-image
# Staging this old is from a killed run; a copy takes seconds to minutes.
stale_minutes=120

fail() {
  echo "install-runtime: $*" >&2
  exit 1
}

set -- "$src_root"/xodus-nexus-runtime-*
if [ "$#" -ne 1 ] || [ ! -f "$1/files/bin/wine" ]; then
  fail "expected one runtime under $src_root"
fi
name=${1##*/}
# The name goes into current.json unescaped.
case $name in *[!A-Za-z0-9._-]*) fail "unexpected runtime name $name" ;; esac
release=$root/releases/$name

mkdir -p "$root/releases"
staging=
cleanup() {
  [ -z "$staging" ] || rm -rf "$staging"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Staging left by killed runs (SIGKILL skips the trap). Only old ones: a younger
# one may belong to a run copying right now.
find "$root" -maxdepth 1 -name '.staging-image-*' -mmin +"$stale_minutes" -exec rm -rf {} + 2>/dev/null || true

if [ ! -f "$release/$marker" ]; then
  staging=$(mktemp -d "$root/.staging-image-XXXXXX")
  echo "install-runtime: installing $name"
  # tar, not cp -a: an unprivileged copy must not try to keep the image's owners.
  # The reading side's status is checked too: sh has no pipefail everywhere.
  { tar -C "$src_root" -cf - "$name" || echo failed >"$staging/.read-failed"; } | tar -C "$staging" -xf -
  [ ! -e "$staging/.read-failed" ] || fail "could not read all of $name"
  : >"$staging/$name/$marker"
  # A release without the marker is debris (an older, interrupted install):
  # releases are only ever published whole, with the marker, by the rename below.
  if [ -e "$release" ] && [ ! -f "$release/$marker" ]; then
    rm -rf "$release" 2>/dev/null || true
  fi
  # Renaming into releases/ fails, rather than nesting, when another run
  # published the same release first; then that one is used.
  if ! mv "$staging/$name" "$root/releases/" 2>/dev/null; then
    [ -f "$release/$marker" ] || fail "could not install $name"
  fi
fi

previous=$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$root/current.json" 2>/dev/null | head -n 1 || true)
if [ "$previous" != "$name" ]; then
  # Written whole, then renamed over, as Nexus writes it (mode 0600).
  pointer=$(mktemp "$root/.current.json.XXXXXX")
  printf '{\n  "name": "%s",\n  "winePath": "%s",\n  "commit": "%s",\n  "installedAt": "%s"\n}\n' \
    "$name" "$release/files/bin/wine" "$name" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$pointer"
  mv "$pointer" "$root/current.json"
  echo "install-runtime: Nexus now uses $name (was ${previous:-none})"

  for old in "$root"/releases/*/"$marker"; do
    [ -f "$old" ] || continue
    dir=${old%/"$marker"}
    case ${dir##*/} in "$name" | "$previous") continue ;; esac
    echo "install-runtime: removing ${dir##*/}"
    # A concurrent run may be pruning the same release.
    rm -rf "$dir" 2>/dev/null || true
  done
fi
