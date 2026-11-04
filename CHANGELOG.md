# Changelog

## 0.1.0

Prepared for the first npm publish; publication and marketplace registration are pending.

- Lossless Flutter ARB import/export for inlang, including resource attributes, placeholder formatting metadata, and existing file formatting.
- Marketplace manifest, original catalog/locale icon, and versioned installation URL: `https://cdn.jsdelivr.net/npm/inlang-plugin-arb@0.1.0/dist/index.js`.
- Local marketplace contracts and hostile fixtures; packed plugin loading through the SDK with browser compatibility checks.
- Explicit Node 22/24/26 quality gates, high-severity dependency audit, pinned actions, and a tag-only npm Trusted Publisher workflow with provenance.
- Includes the already-merged fixes for [#1](https://github.com/sunderee/inlang-plugin-arb/issues/1) (enforce the variant expansion budget) and [#2](https://github.com/sunderee/inlang-plugin-arb/issues/2) (preserve inputs that collide with plural locals).

After merge to the default branch, `master`, configure npm Trusted Publisher for `sunderee/inlang-plugin-arb` and `publish.yml` with permission to run `npm publish`, tag `v0.1.0`, and let the release workflow publish. Then submit a separate registry PR against `opral/inlang`, adding an unused key under `m` in `packages/marketplace-registry/registry.json` pointing to:

```text
https://raw.githubusercontent.com/sunderee/inlang-plugin-arb/refs/heads/master/marketplace-manifest.json
```

The inlang.com listing becomes available only after that registry PR is merged and the site is deployed.
