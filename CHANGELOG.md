# Changelog

## 1.0.0

First npm publish of `inlang-plugin-arb@1.0.0`. Marketplace registration is pending [opral/inlang#4521](https://github.com/opral/inlang/pull/4521).

- Lossless Flutter ARB import/export for inlang, including resource attributes, placeholder formatting metadata, and existing file formatting.
- Marketplace manifest, original catalog/locale icon, and jsDelivr `@latest` installation URL: `https://cdn.jsdelivr.net/npm/inlang-plugin-arb@latest/dist/index.js`. The inlang registry build requires `@latest` and rejects pinned versions.
- Local marketplace contracts and hostile fixtures; packed plugin loading through the SDK with browser compatibility checks.
- Explicit Node 22/24/26 quality gates, high-severity dependency audit, pinned actions, and a tag-only npm Trusted Publisher workflow with provenance.
- Includes the already-merged fixes for [#1](https://github.com/sunderee/inlang-plugin-arb/issues/1) (enforce the variant expansion budget) and [#2](https://github.com/sunderee/inlang-plugin-arb/issues/2) (preserve inputs that collide with plural locals).

The registry PR against `opral/inlang` adds an unused key under `m` in `packages/marketplace-registry/registry.json` pointing to:

```text
https://raw.githubusercontent.com/sunderee/inlang-plugin-arb/refs/heads/master/marketplace-manifest.json
```

The inlang.com listing becomes available only after that registry PR is merged and the site is deployed. The default branch is `master`.
