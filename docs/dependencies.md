# Dependency decisions

The plugin has two direct runtime dependencies. Direct dependencies track the latest published release (`pkg@latest` via `npm run deps:upgrade`). The lockfile records the exact resolved tree that tests and CI install.

| Dependency            | Purpose                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `@inlang/sdk`         | Public plugin/data types, the JSON entry-preservation helper, and actual SDK integration             |
| `@inlang/plugin-icu1` | Authoritative ICU-to-inlang mapping and serialization, including exact matches and nested conditions |

The initial implementation also imported these packages directly:

| Removed direct dependency | Previous purpose                                              | Replacement                                                                                                                        |
| ------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `@messageformat/parser`   | ICU syntax inspection, expansion limits and Flutter rendering | Local bounded parser with regular-expression tokens; the inlang ICU mapper still performs the actual model conversion              |
| `@sinclair/typebox`       | Schema building and seven-field settings validation           | Small local validator and a JSON Schema carrying the standard symbol tags expected by inlang's public schema type                  |
| `jsonc-parser`            | JSON diagnostics, duplicate keys and depth checks             | Native `JSON.parse` plus an iterative regular-expression token scan for duplicate decoded keys, finite numbers and container depth |
| `@types/moo`              | Declarations required by the external parser's types          | No longer needed by the public/local types                                                                                         |

The SDK and ICU plugin themselves still depend on TypeBox (`^0.31.17`) and an ICU parser. Removing our direct imports does not remove those transitive dependencies. TypeBox 0.31 declarations fail modern TypeScript with `skipLibCheck: false` (`Excessive stack depth` in `UnionToTuple`). The `@sinclair/typebox` override therefore stays on the latest 0.34 release that typechecks, currently `0.34.52`. Library checking stays enabled. Package-loader tests verify that the local schema works with the SDK's own TypeBox validator. `npm run deps:upgrade` refreshes that override to the latest published TypeBox after installing `@latest` for every direct dependency; it never empties `dependencies` or `devDependencies`.

ESLint, its JS configuration package, `typescript-eslint`, and Prettier were replaced by `@biomejs/biome`. Biome enables recommended project/type/test lint rules, formatting and import organization. `useLiteralKeys` is disabled because it conflicts with TypeScript's `noPropertyAccessFromIndexSignature`; the stricter compiler option remains enabled. Biome also formats Markdown and YAML. See [Biome configuration](https://biomejs.dev/reference/configuration/).

The remaining development dependencies each support a distinct verification/build requirement:

| Dependency            | Why it remains                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `typescript`          | Strict compilation, including dependency declarations and exported `.d.ts` files                                       |
| `@types/node`         | Node filesystem/process types used by integration tests                                                                |
| `esbuild`             | Bundles a self-contained browser ES module that inlang can load from a data URL                                        |
| `vitest`              | Test execution and assertions                                                                                          |
| `@vitest/coverage-v8` | Coverage reports and enforced thresholds                                                                               |
| `fast-check`          | Reproducible generated Unicode/JSON/nested-message tests with shrinking                                                |
| `intl-messageformat`  | An independent ICU runtime oracle, complemented by an independent generated-AST evaluator and actual Flutter execution |
| `@biomejs/biome`      | Linting, formatting and import organization                                                                            |

The clean npm installation decreased from 172 packages to 80. The browser bundle decreased from approximately 475 kB to 179 kB before compression; source maps are separate. These figures refer to the lockfile and build after this refactor, not a promise about future upstream dependency versions.

Regular expressions handle token recognition, whitespace, identifiers, path/locale normalization, prefixes and literal detection. Nested messages still require a parser with a cursor and bounded recursion. Direct extraction of an already delimited formatter style remains a simple substring operation; disguising it as a dynamic regular expression would make the code harder to verify.
