---
paths:
  - .github/workflows/runtime.yml
  - scripts/runtime-image/**
---

# Runtime deploy to direwolf

- Every runtime built on `main` (runtime.yml `build`) is pushed as
  `ghcr.io/xerktech/xodus-nexus/runtime:<version>` and pinned by digest in xerktech/ArgoCD
  `streaming/direwolf/app-nexus.yaml` (`deploy-argocd`). Argo then rolls it out; no hand step.
  - direwolf runs that image as an initContainer of the `nexus` App (copied to every per-game App);
    `install-runtime.sh` installs it into the shared home and rewrites Nexus's `current.json`.
  - The ArgoCD line must stay one anchored `image: ghcr.io/xerktech/xodus-nexus/runtime...` line;
    the job's sed and guard grep match only that shape and fail loudly otherwise.
- Only runtime-input changes build a runtime (`scripts/ci/runtime-needed.mjs`); a dispatch of
  runtime.yml on `main` forces one.
- `ARGOCD_PUSH_TOKEN` (a PAT with write access to xerktech/ArgoCD) lives in the main-only
  `argocd-deploy` environment, never as a repo secret.
- The image must stay public: the streaming namespace has no GHCR pull secret.
- `install-runtime.sh` runs as uid 1000 (the shared home's owner) in busybox: POSIX sh only, no
  `-x` checks on the source tree, and it prunes only releases it installed (marker file).
  Tests: `scripts/runtime-image/install-runtime.test.mjs`.
