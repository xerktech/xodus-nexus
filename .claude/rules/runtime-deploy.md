---
paths:
  - .github/workflows/runtime.yml
  - scripts/runtime-image/**
---

# Runtime deploy to direwolf

- Every runtime built on `main` (runtime.yml `build`) is pushed as
  `ghcr.io/xerktech/xodus-nexus/runtime:<version>` and pinned by digest in xerktech/ArgoCD
  `games/direwolf/app-nexus.yaml` (`deploy-argocd`). Argo then rolls it out; no hand step.
  - direwolf runs that image as an initContainer of the `nexus` App (copied to every per-game App);
    `install-runtime.sh` installs it into the shared home and rewrites Nexus's `current.json`.
  - The ArgoCD line must stay one anchored `image: ghcr.io/xerktech/xodus-nexus/runtime...` line;
    the job's sed and guard grep match only that shape and fail loudly otherwise.
- Only runtime-input changes build a runtime (`scripts/ci/runtime-needed.mjs`); a dispatch of
  runtime.yml on `main` forces one.
- `ARGOCD_PUSH_TOKEN` (a PAT with write access to xerktech/ArgoCD) lives in the main-only
  `argocd-deploy` environment, never as a repo secret.
- The image must be public: the games namespace has no GHCR pull secret.
  - A new GHCR package starts private whatever the repo's visibility; it was made public by hand
    once, in the package settings, before ArgoCD first pinned it.
- `install-runtime.sh` runs as uid 1000 (the shared home's owner) in busybox; CI tests it with dash.
  - POSIX sh only: no pipefail (check each pipe side), no `-x` checks on the source tree.
  - No lock (busybox has no flock, and a SIGKILLed mkdir lock blocked sessions): each run copies
    into private staging and publishes with one rename into `releases/`, which fails instead of
    nesting when another run won. A marked release is therefore always whole.
  - It prunes only releases it installed (marker file), only when switching, and keeps the
    release `current.json` named until then: a running session may still read it.
  - Tests: `scripts/runtime-image/install-runtime.test.mjs`.
