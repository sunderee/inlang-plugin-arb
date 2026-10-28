# Review: Flutter ARB inlang plugin (pre-refactor snapshot)

I read everything under `src/`, `tests/` and `scripts/`, plus the README, the docs and the examples. I could not see `node_modules`, so any claim about how `@inlang/plugin-icu1` or the SDK helpers behave is labelled as a hypothesis. **Confirmed** means I traced it through this repository's code. I ran nothing.

---

## 1. Prioritized findings

### P1. Exact-only plural cases silently become category cases on export (confirmed)
`src/flutter.ts:295-315`: when an `=0`, `=1` or `=2` case exists and the matching `zero`, `one` or `two` case does not, the exact case is renamed to the category case. The code only raises an error when both cases exist and differ. In Flutter, `=1` and `one` mean the same thing, so a plural with only `=1` cannot be written to ARB. This export changes what users see in any locale where the category covers more numbers than the exact value.

- Counterexample: in an inlang editor, the user creates `{n, plural, =1 {Exactly one} other {{n} items}}` for `ru` (or `=0` for `lv`).
- The export writes `one {Exactly one}`. Flutter then shows "Exactly one" for 21, 31 and so on. In `lv`, `zero` also covers 10–20, 30, …
- Import always creates the pair, so this only affects data written by an editor or another tool. That is exactly the case the README says is rejected ("rejects divergent exact/category patterns").
- Fix: throw when an exact case has no matching category case, or document that it widens.

### P2. Locale identity is checked in canonical form but looked up by the raw string (confirmed)
`resolveSettings` checks that `baseLocale` is in `locales` after canonicalising both (`src/settings.ts:64-70`). The lookups afterwards compare raw strings:
- `src/index.ts:71`: the template document
- `src/index.ts:205`, `:210`: template attributes and the base metadata record
- `src/index.ts:271`: placeholder metadata for the base locale
- `src/index.ts:186` and `:256`: metadata records are keyed by `file.locale` as spelled at import time

Counterexamples:
- `{baseLocale: "en-us", locales: ["en-US"]}` passes validation. The template becomes `object()`, so in relaxed mode `{name}` is imported as literal text. Export never writes generated `@key.placeholders`. Nothing raises an error.
- Respelling a project locale between import and export (for example `zh-hant-tw` → `zh-Hant-TW`) leaves its metadata record unmatched, so `previous === undefined`. The export then drops every description and placeholder from that file and generates a new `@@locale`.
- Fix: key every map by `canonicalLocale(...)`, or store the canonical `baseLocale` in `ResolvedSettings`.

### P3. Whole-file export changes key order (confirmed; the tests hide it)
`src/index.ts:259-279` and `:326` build each file as: all previous `@`/`@@` attributes, then (base locale only) generated `@key` entries, then `@@locale`, then all resources.

- The test at `tests/formatting.test.ts:97-130` actually produces `{"@hello":…, "@@locale":"pt_BR", "hello":…}`.
- An existing file `{"@@locale","hello","@hello","next","@next"}` comes out as `{"@@locale","@hello","@next","hello","next"}`.
- This path runs whenever there are no previous `files`: the first save to a new directory, `project.exportFiles()` without `files`, and `scripts/test-flutter.mjs`.
- The test named "preserves every metadata field, extensions, types **and ordering**" (`tests/plugin.test.ts:94-146`) compares with `toEqual`, which ignores key order. So does every round-trip test.
- Hypothesis: when `keepUnchangedJsonEntries` adds a new message to an existing file, it may also place `@new` before `new`. Nothing tests this.

### P4. Removing a locale from settings blocks every export (confirmed; possibly intended)
`src/index.ts:364-366` throws if any message has a locale that is not configured. That happens after all files are built, and it fails the whole export. If a user removes `fr` from settings while `fr` messages are still in the database, saving fails for every locale. `tests/validation.test.ts:147-149` locks this behaviour in. I suggest skipping those messages, or reporting the problem without failing the entire save.

### P5. In relaxed mode, literal `{foo}` can turn into an interpolation (confirmed)
- `icuToFlutter.literal` (`src/flutter.ts:246-257`) only rejects literal braces when they wrap one of the bundle's **input declarations** (`names`, `src/index.ts:317-324`).
- Export re-validation (`src/index.ts:329-335`) and import both use the **template placeholder set** instead.
- Counterexample: the template has `"@x":{"placeholders":{"foo":{}}}` and `x: "hi"`. The editor sets `x`'s text to the literal string `{foo}`. The export writes `"x": "{foo}"`, validation accepts it, and Flutter/reimport treat it as a placeholder.
- Related: the re-validation set includes placeholders generated for bundles the base locale doesn't contain (`src/index.ts:207-254`), but those are never written to the base file (`:271-276`). Validation therefore assumes a template that is not on disk.
- Fix: pass the union of the template placeholders and the inputs into `icuToFlutter`.

### P6. Whether a resource is non-text is decided per locale, not from the template (confirmed)
`src/index.ts:96-100` (import) and `:293-297` (export) read `@key.type` from **each locale's own** document. Translations usually leave out attributes.

- Counterexample: en `{"css":"a{b}","@css":{"type":"css"}}`, de `{"css":"a{b}"}`. The en file imports as literal text; the de file goes through `flutterToIcu`, gets `{b}` and fails with "Expected ","" at import.
- Hypothesis: Flutter's `gen-l10n` may not honour `type` at all, so a non-text resource may break the Flutter build anyway. Nothing in the native tests covers it.

### P7. The ARB nesting limit can make an imported project impossible to export (confirmed)
- `json.ts:38-41` counts depth in jsonc-parser tree nodes. Each object level adds two nodes (property, then value), so "JSON nesting at 64 levels" (README:82) is really about 32 levels of objects. Arrays add one node per level, which is why the test at `tests/plugin.test.ts:428` passes.
- `readMetadataBundle` re-parses the stored metadata with the same limit (`src/metadata.ts:43-46`). The stored JSON wraps the ARB attributes in one more object, which adds two nodes.
- Counterexample: `{"@@x": {"a": {"a": … {"a": 0}}}}` with 32 objects in total imports fine. Every later export then throws `JSON nesting exceeds 64 levels` for `@inlang/arb/en`, and the error fails the whole export.
- Fix: count only container depth, and give the metadata re-parse one level of headroom.

### P8. Hypotheses that need a test before anyone relies on them
- **H1, `maxVariants` is not a true pre-bound.** `count()` (`src/flutter.ts:208-233`) multiplies across adjacent choices and **adds** across nested choices, i.e. it counts leaf paths. If `parseMessage` instead hoists nested selectors and builds the full Cartesian product, nested chains are undercounted. The check after materialisation (`src/index.ts:128-131`) would then run too late; if the count is exact, that check is dead code. On export, `validateModel` limits variants but not **selectors** (`src/model.ts:92-95`). If `serializeMessage` expands the full selector tree, 20 selectors with 21 variants could build a very large string before `validateIcu` runs.
- **H2, multi-file byte preservation.** If `keepUnchangedJsonEntries` re-imports each previous file on its own, non-base files in relaxed mode are imported without a template. Unchanged entries would then compare as changed and get canonicalised, or compare equal by accident. Every formatting test passes a single `en` file.
- **H3, importing a single locale.** If the SDK upsert replaces `bundle.declarations`, importing only `de` would drop `en`'s locale-specific variables (`count__arb_en`) and any `en`-only inputs. `en` export would then fail with "Undeclared variable". `docs/api.md:49` documents this, but nothing tests it, and the locale-specific local names make it fail even when every locale has the same plural shape.
- **H4, Flutter allows `$` in resource IDs.** My recollection of `_isValidGetterAndMethodName` is that it accepts `$`. The plugin's `/^[a-zA-Z][a-zA-Z0-9_]*$/` (`src/index.ts:90`, `:285`) would then reject valid catalogs.
- **H5, `localeFormat: "bcp47"`.** It produces `app_pt-BR.arb` and `"@@locale":"pt-BR"`. Whether `gen-l10n` accepts hyphens there has not been checked against Flutter.
- **H6, nested braces in relaxed mode.** In relaxed mode, a literal `{x}` or stray `}` inside a select/plural case ends the case early (`src/flutter.ts:76-79` and `:88-95` don't track depth). It fails loudly rather than silently, but may differ from Flutter's relaxed lexer.

### P9. Minor confirmed issues
- `src/model.ts:172-177`: duplicate variants are detected via `JSON.stringify` of the match objects, so the result depends on the objects' property order. A `catchall` match and a literal `"other"` match on the same selector are not treated as duplicates.
- Metadata `keys` are fixed at import. If `@b` is added through `createMetadataBundle` for a message created in inlang and that message is deleted later, `@b` is kept forever as an "orphan".
- Missing files in this copy:
  - `tsconfig.build.json`, which `package.json` `build` references
  - `LICENSE`, listed in `files`
  - an ESLint config
  - a lockfile

  If those are missing upstream too, `npm run build`/`check` would fail, along with `test:package`/`test:flutter`, which need `dist/`.

---

## 2. Tests: improve, remove, add

### Shared-oracle blind spots
- **One converter on both sides.** These semantic tests run `flutterToIcu` on both the input and the output before passing them to `IntlMessageFormat`:
  - `tests/plugin.test.ts:16-39`
  - `:40-63`
  - `:148-168`
  - `:170-188`
  - `:209-230`

  A wrong Flutter model (alias precedence, `#`, apostrophes, exact numbers checked before CLDR rules) is wrong the same way on both sides. The escaping test only compares two ICU strings and never the text a user would see. Only `scripts/test-flutter.mjs` is an independent oracle.
- **Identity round trips can't tell parsing from pass-through.** These tests would still pass if the plugin treated `{name}` as literal text:
  - `tests/plugin.test.ts:232-242` (relaxed mode)
  - `:201-207` (date/time)
  - `:65-76`

  Add model-level assertions (expression vs text), as `:78-92` already does.
- **Formatting tests trust the plugin's own definition of "unchanged".** They feed `importFiles` and `exportWholeFiles` into `keepUnchangedJsonEntries`, so they only cover cases where import is faithful. All of them use one file.
- **`helpers.materialize` and the copy in `test-flutter.mjs:23-50` skip the SDK.** Only `tests/sdk.test.ts` uses real database rows, and only for a flat `Hello {name}`. Plurals, local variables, selectors and matches never go through SDK storage.
- **`toEqual` on parsed JSON ignores order, whitespace and the trailing newline** (P3).

### Do the native Flutter tests cover real exported edits? No.
`scripts/test-flutter.mjs:80` exports **unedited** imported catalogs through whole-file export (no `files`). That is not the `keepUnchangedJsonEntries` path the SDK uses when saving. Flutter never compiles:
- placeholder metadata generated for new messages (`num`, `DateTime`, `String`)
- an edited `=1`/`one` pair, or the exact-only widening from P1
- files after deletions or renames
- mixed files where some entries keep their bytes and others are rewritten
- generated `@@locale` or file names for new locales, or `bcp47`
- non-text resources

Assertions also stop at `en` plus a few `ar`/`sl` calls. The `de`, `zh*` and the reordered output are only checked for compiling.

### Add
1. Edits to an exact/category pair:
   - edit both cases, then export
   - edit one case: expect the "cannot distinguish" error
   - delete the category case: expect an error, or `lv` behaviour asserted natively (P1)
   - category before exact (`one {A} =1 {B}`) on import, with B winning
2. A whole-file export that asserts the exact bytes, including key order (P3).
3. `baseLocale` and locale respelling (P2).
4. Relaxed mode, literal `{foo}` where `foo` is a template placeholder but not an input (P5).
5. A template non-text resource with a translation that has no attributes (P6).
6. Nesting depth near the limit through import, metadata, then export (P7).
7. A unit test that `count()` equals `parseMessage(...).variants.length` for random nested/adjacent shapes, plus an export with many selectors and few variants (H1).
8. Multi-locale `files` byte preservation in relaxed mode, with a non-base edit (H2).
9. SDK: a plural message through snapshot, then a database edit of one variant, then export. SDK: import of a single locale into an existing project with two locales (H3).
10. Flutter native: build the catalogs by **editing the model** first (new message, edited plural, deleted key, new locale), export **with `files`**, then compile and assert the `de` and the newly added outputs.
11. A property test that generates random Flutter ASTs (nested select/plural, text containing `'{}#`, relaxed on/off) and checks import→export→import **model** equality, not string equality through `flutterToIcu`.

### Improve
- `tests/plugin.test.ts:190-199`: `toContain("plural")` is weak. Assert the exported `another` value and both `count` values exactly. This is the only check on the clash between a locale's plural variable and an input named `nPlural`.
- `tests/validation.test.ts:21-41`: assert the diagnostic text, not just `ArbError`. As written, it cannot show which check rejected each case.
- The diagnostic table locks in misleading messages:
  - `offset:1` → "Invalid plural category" (`tests/plugin.test.ts:360`)
  - `"@@locale":42` → "does not match" (`:381`)

  Fix the messages, then the expectations.

### Remove or merge
- `tests/plugin.test.ts:434-436` and `tests/validation.test.ts:444-447` only exist to raise coverage. Fold them into existing tests.

---

## 3. Code-quality improvements
- **Duplicated logic:**
  - the alias table (`src/flutter.ts:155-159`, `:298-303`)
  - the literal-resource check (`src/index.ts:97-100`, `:294-297`; this should be one template-based helper, see P6)
  - the resource-ID regex (`:90`, `:285`)
  - the `@@locale` check (`:57-63`, `:344-353`)
  - default values in both the schema and `resolveSettings` (`src/settings.ts:13-32` vs `:71-79`)
- **Placeholder type inference is quadratic.** `src/index.ts:232-247` loops `variants.some(... messages.some(...))` for each input. With no base metadata record (a project authored entirely in inlang), that means scanning all variants for every input. Use `byMessage` and a map from message to bundle.
- `src/flutter.ts:249-252`: the global-regex `.test` before `matchAll` is redundant.
- **Misleading diagnostics:**
  - `src/flutter.ts:204` reports "32 levels" when the check is brace depth > 128
  - errors from `validateIcu`/`parse` report offsets in the **converted** ICU string (with inserted exact cases and escaping), not the ARB source
- `@types/moo` is listed as a runtime dependency. This matters for the planned dependency reduction.
- `exportWholeFiles` (`src/index.ts:171-368`) does validation, placeholder inference, metadata merging and rendering in one function. Splitting it would make P2, P3 and P5 easier to fix and test.

---

## 4. Already well tested
- Strict JSON intake (`tests/plugin.test.ts:344-397`, `:425-432`):
  - duplicate keys at any depth
  - comments and trailing commas
  - invalid UTF-8 and the BOM
  - non-finite numbers
  - a large table of malformed-message cases with file context
- Byte preservation for one file (`tests/formatting.test.ts:5-51`): CRLF, tabs, BOM, `\u` escapes, compact JSON and ICU spelling without spaces, including a single-entry edit.
- Deletion rules (`tests/formatting.test.ts:53-95`):
  - attributes are removed with their resource
  - globals and orphan attributes are kept
  - after all bundles are deleted, the previous `files` still provide the metadata needed for cleanup
- Export-side model validation (`tests/validation.test.ts:107-346`): markup, literal expressions, dynamic options, duplicates, missing fallback, selector functions and options, non-text shape.
- Metadata persistence: the stored copy is independent of edits and the format version is checked (`tests/plugin.test.ts:137-145`, `tests/validation.test.ts:67-96`). A real SDK snapshot survives close and reopen (`tests/sdk.test.ts:15-77`).
- Prototype-pollution resistance (`tests/validation.test.ts:97-104`) and name clashes in the locale-specific local variables (`:395-442`).
- Real SDK directory save (`tests/sdk.test.ts:79-117`) and loading the bundled module through the SDK's loader (`scripts/test-package.mjs`).
- Native Flutter, for the import→canonical export path: precedence between `=1` and `one`, literal `#` in a select nested in a plural, numeric select keys, apostrophe escaping, relaxed mode with only the template carrying metadata, number/currency metadata, custom dates and date skeletons. This is the only test that does not reuse the plugin's own converter, and it should be extended to cover edits (§2).
