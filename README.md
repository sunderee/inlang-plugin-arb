# Flutter ARB plugin for inlang

Imports Flutter Application Resource Bundle (`.arb`) files into inlang and exports them back for `flutter gen-l10n`. Text, placeholders, plurals, selects and nested messages become editable inlang bundles, messages and variants. ARB attributes and Flutter formatting metadata survive a saved/reopened inlang project, even when the original files are unavailable.

Requires inlang SDK **4.0.4 or later**. Development supports Node.js **22.13+, 24, or 26+**. The built plugin is a self-contained browser-compatible ES module; Flutter apps need no JavaScript runtime.

## Build and install locally

```sh
npm ci
npm run check
```

Copy `dist/index.js` to `plugins/arb.js` beside `project.inlang` in your Flutter repository. Configure `project.inlang/settings.json`:

```json
{
  "$schema": "https://inlang.com/schema/project-settings",
  "baseLocale": "en",
  "locales": ["en", "de", "zh", "zh-Hant-TW"],
  "modules": ["./plugins/arb.js"],
  "plugin.inlang.arb": {
    "pathPattern": "./lib/l10n/app_{locale}.arb",
    "useEscaping": true
  }
}
```

Paths are relative to the directory containing `project.inlang`. The default discovers `app_en.arb`, `app_de.arb`, `app_zh.arb` and `app_zh_Hant_TW.arb`. Keep project locales in BCP 47 form, such as `zh-Hant-TW`; the plugin converts filenames and new `@@locale` values to Flutter's underscore form. Existing equivalent locale spellings are preserved. Flutter requires the base language catalog as a fallback for script/region locales, so include `zh` alongside `zh-Hant-TW`.

Match the escaping settings in Flutter's `l10n.yaml`:

```yaml
arb-dir: lib/l10n
template-arb-file: app_en.arb
output-localization-file: app_localizations.dart
use-escaping: true
```

Then use your inlang editor to translate and save, and run `flutter gen-l10n` as usual. [A complete example](examples/flutter) includes English and German catalogs. No package has been published; use the local bundle or host that file at a versioned HTTPS URL for shared projects.

## Supported features

| ARB / Flutter feature                                          | Behavior                                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Strings, empty strings, Unicode, multiline text, JSON escaping | Preserved; HTML is literal text                                                              |
| `{name}` placeholders                                          | Input declarations and expression pattern parts                                              |
| Plurals and all six categories                                 | Native selectors and variants, including Flutter's numeric behavior                          |
| `=0`, `=1`, `=2`                                               | Flutter category aliases; the later alias wins                                               |
| Selects, numeric select keys, nested/adjacent choices          | Imported and exported with conditions intact                                                 |
| Apostrophe escaping                                            | Matches `use-escaping`, including doubled apostrophes and literal braces                     |
| Relaxed syntax                                                 | Matches `relax-syntax`; template placeholder metadata controls recognition                   |
| Inline date/time skeletons                                     | `{when, date, ::yMMMMd}` and `{when, time, ::Hm}`                                            |
| Number/currency formatting                                     | Retains `type`, `format`, and `optionalParameters`                                           |
| Date formatting                                                | Retains named/combined formats and `isCustomDateFormat` patterns                             |
| Resource attributes                                            | Retains descriptions, contexts, examples, screenshots, source text, and arbitrary extensions |
| Global attributes                                              | Retains `@@locale`, `@@context`, timestamps and arbitrary JSON extension values              |
| Non-text resources                                             | Explicit non-`text` resource types remain literal strings                                    |
| Empty / metadata-only files                                    | Persist through inlang without fake translatable messages                                    |
| Existing file formatting                                       | No-op saves preserve bytes; changed entries retain surrounding formatting                    |
| Deleted resources                                              | Removes the resource and its attributes; retains globals and original orphan attributes      |
| General ICU1 compatibility                                     | Opt-in `syntax: "icu"` supports ordinals, offsets, `#` substitution and formatter styles     |

Flutter's syntax and runtime differ from general ICU. In Flutter mode, `#` is literal text; it does **not** substitute the count. Interpolate `{count}` explicitly. `=0`/`zero`, `=1`/`one`, and `=2`/`two` are paired aliases, not distinct branches. Numeric 0/1/2 are tested before locale category rules. The plugin models both behaviors; it rejects missing or divergent exact/category pairs introduced by an editor because Flutter cannot represent that distinction. Keep both paired variants present and consistent when editing them directly.

Flutter does not support plural offsets, `selectordinal`, arbitrary exact values such as `=7`, or inline ICU number formatters. Use Flutter placeholder metadata for numeric formatting. The plugin rejects these in Flutter mode instead of generating files that Flutter cannot compile. ICU mode is for ARB consumers with a general ICU1 runtime; it does not make these features work in Flutter.

## Configuration

All options are optional, under `plugin.inlang.arb`. The generated JSON Schema is `dist/settings-schema.json`.

| Setting            | Default                       | Meaning                                                                                                                    |
| ------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pathPattern`      | `./lib/l10n/app_{locale}.arb` | One relative POSIX path with exactly one `{locale}`                                                                        |
| `localeFormat`     | `underscore`                  | `underscore` or `bcp47` for filenames; new Flutter `@@locale` values always use underscores                                |
| `useEscaping`      | `false`                       | Must match Flutter `use-escaping`                                                                                          |
| `useRelaxedSyntax` | `false`                       | Must match Flutter `relax-syntax`                                                                                          |
| `syntax`           | `flutter`                     | `flutter` or general `icu`                                                                                                 |
| `indentation`      | `2`                           | Spaces for new files, from 0 to 8                                                                                          |
| `maxVariants`      | `4096`                        | Maximum expanded variant count per message, from 1 to 100000; enforced during Flutter conversion, including alias branches |

One catalog per configured locale is supported. Missing locale files are handled by the SDK. The plugin does not invent untranslated messages or copy the base text into other locales. Import related catalogs as a complete batch so shared declarations remain available. Multiple catalogs/namespaces should use separate inlang projects. Locale identity is canonicalized, so equivalent case/hyphen/underscore spellings retain metadata. Messages for locales outside the configured set cause an error; explicitly delete or migrate them before removing a locale. Files must be strict UTF-8 JSON objects: duplicate JSON keys, comments, trailing commas, non-string resources and malformed known metadata fields produce contextual errors. Message nesting is bounded at 32 levels and JSON nesting at 64 containers.

Existing number/date formatting metadata remains authoritative. Newly created Flutter messages get basic placeholder metadata in the base locale: `String`, `num` for plural inputs and `DateTime` for date/time expressions. Review formats and examples for new placeholders as part of authoring your template.

## Development and verification

```sh
npm run typecheck       # All strict TypeScript checks; dependency declarations also checked
npm run lint            # Biome linting, including project/type/test rules
npm run format:check    # Biome formatting checks
npm test                # Unit, property, semantic, formatting and real SDK integration tests
npm run test:coverage   # Enforces coverage thresholds; writes coverage/index.html and lcov.info
npm run build           # Bundled ESM, source map, declarations and settings schema
npm run test:package    # Load the built file through the SDK's real module loader
npm run test:flutter    # Requires Flutter; compiles exported ARB and runs generated Dart tests
npm pack --dry-run      # Inspect the distributable package
npm run deps:upgrade    # Install @latest for every direct dependency; refresh the TypeBox override
```

`npm run test:flutter` builds a temporary Flutter test project using the **built** plugin and example catalogs. Run `npm run build` first. It checks actual generated getters/methods for interpolation, plural alias precedence, nested choices, literal `#`, apostrophes, number/currency formatting, custom dates and date skeletons. It then edits real SDK database rows, creates messages with inferred `num`/`DateTime` types, deletes and renames resources, saves with existing files, and compiles the resulting ARB. It also verifies a new BCP 47 filename and both escaping/relaxed modes. It removes the temporary project on completion. Set `FLUTTER_BIN` to use a specific Flutter executable.

Development uses npm's lockfile, Biome and strict TypeScript with dependency declarations checked (`skipLibCheck: false`). Direct dependencies track the latest published versions; `npm run deps:upgrade` installs each named package at `@latest` and refreshes the TypeBox override without clearing the manifest. The only direct runtime dependencies are `@inlang/sdk` and `@inlang/plugin-icu1`. Settings validation, bounded ICU inspection and JSON duplicate-key scanning are local code. The SDK and ICU plugin still bring TypeBox 0.31 and an ICU parser transitively; the TypeBox 0.34 override is required so their older declarations do not fail type checking. The build bundles dependencies and has no runtime imports. Biome formats JavaScript, TypeScript, JSON, Markdown and YAML.

See [dependency decisions](docs/dependencies.md), [Claude Code's review](docs/reviews/claude-original.md) and [review resolutions](docs/reviews/resolution.md), [design and data preservation](docs/design.md), [API usage](docs/api.md), and [investigation and compatibility notes](docs/research.md) for details.
