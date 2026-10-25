#!/bin/sh
# Installs the runtime baked into this image into Xodus Nexus's runtime root and
# points Nexus at it, as Nexus's own installer does: the tree goes to
# <root>/releases/<name>, then current.json (which Nexus reads at start) names its
# wine. Runs as direwolf's initContainer on the shared home before every Nexus
# session, so the fork's runtime replaces whatever upstream runtime was installed.
#
# Copies only when the release is missing; a re-run with the same image is a no-op.
# Releases this script installed earlier are pruned, except the one current.json
# named before (a session may still be reading it); upstream installs are kept.
set -eu

src_root=${RUNTIME_SOURCE:-/runtime}
root=${XODUS_RUNTIME_ROOT:-/config/.local/share/xodus-nexus/runtimes}
marker=.direwolf-runtime-image

set -- "$src_root"/xodus-nexus-runtime-*
if [ "$#" -ne 1 ] || [ ! -f "$1/files/bin/wine" ]; then
  echo "install-runtime: expected one runtime under $src_root" >&2
  exit 1
fi
name=${1##*/}
release=$root/releases/$name

mkdir -p "$root/releases"
if [ ! -f "$release/$marker" ]; then
  staging=$(mktemp -d "$root/.staging-image-XXXXXX")
  trap 'rm -rf "$staging"' EXIT
  echo "install-runtime: installing $name"
  # tar, not cp -a: an unprivileged copy must not try to keep the image's owners.
  tar -C "$src_root" -cf - "$name" | tar -C "$staging" -xf -
  : >"$staging/$name/$marker"
  rm -rf "$release"
  mv "$staging/$name" "$release"
fi

previous=$(sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' "$root/current.json" 2>/dev/null || true)
if [ "$previous" != "$name" ]; then
  # Written whole, then renamed over, as Nexus writes it.
  printf '{\n  "name": "%s",\n  "winePath": "%s",\n  "commit": "%s",\n  "installedAt": "%s"\n}\n' \
    "$name" "$release/files/bin/wine" "$name" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$root/current.json.tmp"
  mv "$root/current.json.tmp" "$root/current.json"
  echo "install-runtime: Nexus now uses $name (was ${previous:-none})"
fi

for old in "$root"/releases/*/"$marker"; do
  [ -f "$old" ] || continue
  dir=${old%/"$marker"}
  case ${dir##*/} in "$name" | "$previous") continue ;; esac
  echo "install-runtime: removing ${dir##*/}"
  rm -rf "$dir"
done
