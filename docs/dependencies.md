# Dependency decisions

The plugin has two direct runtime dependencies. Both are pinned to the versions used by the integration tests.

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

The SDK and ICU plugin themselves still depend on TypeBox and an ICU parser. Removing our direct imports does not remove those transitive dependencies. The single TypeBox version override remains because its older declarations fail modern strict TypeScript checks; library checking stays enabled. Package-loader tests verify that the local schema works with the SDK's own TypeBox validator.

ESLint, its JS configuration package, `typescript-eslint`, and Prettier were replaced by `@biomejs/biome`. Biome enables recommended project/type/test lint rules, formatting and import organization. `useLiteralKeys` is disabled because it conflicts with TypeScript's `noPropertyAccessFromIndexSignature`; the stricter compiler option remains enabled. Markdown and YAML are outside the formatter's supported-file checks. See [Biome configuration](https://biomejs.dev/reference/configuration/).

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
