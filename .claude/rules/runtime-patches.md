---
paths:
  - assets/*.patch
  - scripts/runtime-patches.lock.json
  - scripts/runtime-tests/*.c
---

# Runtime patch series

- A new runtime fix is one new `assets/*.patch`, appended last in `runtime-patches.lock.json`;
  never edit an earlier patch (later patches' context and hashes depend on it).
  - Diff against the fully patched tree: fetch the lock's `wine` and `xgameruntime` commits
    (xgameruntime into `dlls/xgameruntime`), `git apply` every non-vkd3d patch in lock order.
  - Patch paths are `a/dlls/...`/`b/dlls/...` relative to the Wine tree, no `diff --git`/`index`.
  - Update `expectedXgameruntimeSources` for every file the patch touches; the build rejects a
    tree whose patched sources don't hash to it.
- XUser endpoint table: `match_wildcard` must accept a pattern ending in `*` (title catch-all
  `https://*`). A miss falls back to an XSTS token for `https://<host>`, which XSTS rejects (400),
  failing sign-in; a matched entry with empty TokenType must request no token.
- Tests: `store-entitlements-probe.c` (package + durable licenses), `token-dispatch-probe.c`
  (`test_untyped_endpoint`); they run only in runtime.yml's built runtime under Wine.
