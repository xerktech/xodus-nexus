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
# installs are never touched. Concurrent runs (several sessions starting at once)
# serialize on a lock directory.
set -eu

src_root=${RUNTIME_SOURCE:-/runtime}
root=${XODUS_RUNTIME_ROOT:-/config/.local/share/xodus-nexus/runtimes}
marker=.direwolf-runtime-image
lock=$root/.install-runtime.lock
# A lock older than this is from a run that was killed; a copy takes about a minute.
stale_minutes=30

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
waited=0
until mkdir "$lock" 2>/dev/null; do
  if [ -n "$(find "$lock" -maxdepth 0 -mmin +"$stale_minutes" 2>/dev/null)" ]; then
    echo "install-runtime: breaking a stale lock" >&2
    rm -rf "$lock"
    continue
  fi
  [ "$waited" -lt $((stale_minutes * 60)) ] || fail "timed out waiting for $lock"
  sleep 2
  waited=$((waited + 2))
done
staging=
cleanup() {
  [ -z "$staging" ] || rm -rf "$staging"
  rmdir "$lock" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Copies killed mid-way (SIGKILL skips the trap) leave their staging behind; with
# the lock held no other run is using one.
rm -rf "$root"/.staging-image-*

if [ ! -f "$release/$marker" ]; then
  staging=$(mktemp -d "$root/.staging-image-XXXXXX")
  echo "install-runtime: installing $name"
  # tar, not cp -a: an unprivileged copy must not try to keep the image's owners.
  # The reading side's status is checked too: sh has no pipefail everywhere.
  { tar -C "$src_root" -cf - "$name" || echo failed >"$staging/.read-failed"; } | tar -C "$staging" -xf -
  [ ! -e "$staging/.read-failed" ] || fail "could not read all of $name"
  : >"$staging/$name/$marker"
  rm -rf "$release"
  mv "$staging/$name" "$release"
fi

previous=$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$root/current.json" 2>/dev/null | head -n 1 || true)
if [ "$previous" != "$name" ]; then
  # Written whole, then renamed over, as Nexus writes it (mode 0600).
  (
    umask 077
    printf '{\n  "name": "%s",\n  "winePath": "%s",\n  "commit": "%s",\n  "installedAt": "%s"\n}\n' \
      "$name" "$release/files/bin/wine" "$name" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$root/current.json.tmp"
  )
  mv "$root/current.json.tmp" "$root/current.json"
  echo "install-runtime: Nexus now uses $name (was ${previous:-none})"

  for old in "$root"/releases/*/"$marker"; do
    [ -f "$old" ] || continue
    dir=${old%/"$marker"}
    case ${dir##*/} in "$name" | "$previous") continue ;; esac
    echo "install-runtime: removing ${dir##*/}"
    rm -rf "$dir"
  done
fi
