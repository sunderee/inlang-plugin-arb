# Investigation and compatibility

Investigated on 2026-10-28 using installed Node.js 26.12.1, npm 12.2.1, Flutter 3.47.8 (revision `737ba8f885dc774b53b442759999a312c9461e4e`), Dart 3.13.7, inlang SDK 4.0.4 and ICU plugin 1.3.4.

## Primary sources

- [Writing an inlang plugin](https://inlang.com/docs/write-plugin): the host supplies resource bytes; plugins implement format conversion.
- [Plugin API](https://inlang.com/docs/plugin-api): settings schema, import linkage and SDK 4's existing-file/verbatim contract.
- [Message shapes](https://inlang.com/docs/message-shapes): declarations, expressions, local plural selectors, literal matches and catch-all matches.
- [Data model](https://inlang.com/docs/data-model) and [architecture](https://inlang.com/docs/architecture): persistent bundle/message/variant separation and the role of external compatibility files.
- [Flutter internationalization](https://docs.flutter.dev/ui/internationalization): ARB template files, placeholders, selects/plurals, escaping, NumberFormat and DateFormat metadata, advanced locales and l10n.yaml.
- [ARB specification](https://github.com/google/app-resource-bundle/wiki/ApplicationResourceBundleSpecification): resource values, extensible resource attributes, global attributes and non-text resource types.
- [Flutter message parser](https://github.com/flutter/flutter/blob/737ba8f885dc774b53b442759999a312c9461e4e/packages/flutter_tools/lib/src/localizations/message_parser.dart), [generator](https://github.com/flutter/flutter/blob/737ba8f885dc774b53b442759999a312c9461e4e/packages/flutter_tools/lib/src/localizations/gen_l10n.dart), and [placeholder types](https://github.com/flutter/flutter/blob/737ba8f885dc774b53b442759999a312c9461e4e/packages/flutter_tools/lib/src/localizations/gen_l10n_types.dart): implementation details verified against the installed SDK.
- [Dart Intl.pluralLogic](https://github.com/dart-lang/i18n/blob/main/pkgs/intl/lib/intl.dart): numeric short-circuit behavior before locale category selection.
- [Inlang ICU1 plugin](https://github.com/opral/inlang/tree/main/packages/plugins/icu1): public typed parser/serializer APIs and native exact/category selector representation.

## Findings that affect the implementation

1. **ARB metadata cannot be added as arbitrary row fields.** The published inlang schema does not include ARB descriptions or file attributes. Supported literal local declarations in dedicated, message-free bundles provide durable storage. Real SDK snapshot tests verify this choice.
2. **ICU escaping differs from Flutter escaping.** Flutter only processes apostrophes when `use-escaping` is enabled, and then quotes arbitrary strings. General ICU quotes syntax characters. Flutter hashes stay literal inside plurals. Converting these rules is necessary before using a standard ICU mapper.
3. **Flutter plural aliases are not ICU exact-number branches.** The generator maps `=0/1/2` to `zero/one/two`; later cases override earlier aliases. Other exact values fail generation. The plugin normalizes these rules and the generated Dart tests exercise alias precedence. General ICU mode retains standard ICU behavior instead.
4. **Relaxed syntax depends on the template.** Recognizing `{name}` requires that name to be listed in the base locale's placeholder metadata. Target locales need not repeat the metadata. Import all locale files together so the template is available.
5. **Formatting must retain Dart metadata.** Flutter uses `type`, `format`, `optionalParameters`, and `isCustomDateFormat` to generate typed methods and formatting calls. Mapping these directly to JavaScript formatter options would be lossy.
6. **Directory exports need explicit path overrides.** Project BCP 47 locales use hyphens; Flutter filenames commonly use underscores. Exported `metadata.pathPattern` prevents the host from writing a second file with the wrong spelling.
7. **Source byte preservation requires host support.** SDK 4 supplies previous files. Its JSON helper preserves semantically unchanged entries and marks content verbatim. Direct exports without previous files can guarantee metadata and message meaning, not original JSON layout.

The checked-in tests distinguish source-preserving saves, canonical exports, actual SDK persistence, semantic behavior and actual Flutter code generation. Coverage excludes the third-party ICU parser/serializer; those are dependencies, while this project's adaptation and validation code is included.
