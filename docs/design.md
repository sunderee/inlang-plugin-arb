# Design and data preservation

## Message mapping

The plugin implements inlang's `toBeImportedFiles`, `importFiles` and `exportFiles` interface. It does no filesystem I/O; the host supplies bytes and writes exported files. No process-global cache is used, and imports do not mutate settings or supplied files.

Each resource ID is one bundle. Each resource's locale is one message. Text and interpolations become pattern parts. Choices become selectors and variants. Local declarations are namespaced by locale to prevent different plural shapes or offsets in translations from overwriting one another's derived variables. Input declarations are unioned across locales.

The ICU mapping uses the public `parseMessage` and `serializeMessage` APIs from `@inlang/plugin-icu1`. Local parsers use sticky regular expressions for tokens and bounded recursion for nested messages; a renderer converts serialized ICU back to Flutter. The local ICU inspector rejects malformed syntax and bounds expansion before the mapper runs. Flutter adaptation covers apostrophes, literal hashes, template-controlled relaxed syntax, inline skeletons and plural aliases. Neither a second external ICU parser nor a JSON parser dependency is imported directly.

Flutter's `Intl.pluralLogic` first checks numeric 0, 1 and 2 when the corresponding case exists, then uses locale plural rules. Its generator maps both `=1` and `one` to the same argument, with the later entry taking precedence. The adapter therefore expands each present zero/one/two case to an exact numeric branch and a category branch in inlang's model. This makes the model's meaning explicit. Those patterns must remain consistent: general inlang data can express exact/category distinctions that Flutter cannot express. Export reports those distinctions as errors.

Nested and adjacent conditions can expand into several variants. Expansion is estimated and bounded before the ICU mapper runs. This intentionally conservative bound may reject a large message that a later optimization could reduce; increase `maxVariants` for trusted catalogs when necessary. Deeply nested messages are rejected separately.

## Metadata carriers

The current inlang bundle/message schema has no ARB description or file metadata field. Storing arbitrary properties on imported rows would lose them when the SDK persists its tables. The plugin instead creates one bundle per imported file:

```text
@inlang/arb/en
  declarations[0]: local variable __arb_file_metadata
    expression literal: JSON.stringify({version: 1, locale, keys, attributes, order})
  messages: none
```

`keys` lists the file's original resources. `attributes` contains every top-level `@...` entry, including globals and orphan attributes. The optional `order` records original top-level key order; older carriers without it still export in a stable resource/attribute order. This uses supported SDK row shapes and survives database storage and portable project snapshots. JSON scanning counts containers, and internal carrier parsing allows its one extra wrapper so every valid imported metadata depth can be exported again. Metadata is not inserted into resource patterns, sent as a fake translation, written as an ARB resource, or held in module memory.

The carrier IDs begin with `@`, which is reserved for attributes in ARB and cannot collide with a real ARB resource. Tools listing all bundles may show these bundles; exclude `@inlang/arb/` from translatable bundle lists and preserve them when manipulating project data. `readMetadataBundle` and `createMetadataBundle` provide explicit access for tools. Metadata-only files also have carriers and no messages.

Resource metadata remains keyed by resource ID. Renaming a resource should move `@oldId` to `@newId` and rename its entry in `keys` along with the resource's bundle ID; otherwise the old attributes are removed as part of deletion. When manually adding attributes for a newly authored resource, also add its ID to `keys` so subsequent deletion removes those attributes rather than preserving them as an intentional orphan. Placeholder renames should similarly update placeholder metadata. The plugin cannot infer whether a user intended a rename or a delete/add operation.

Formatting metadata is preserved as ARB data, not translated into JavaScript `Intl` formatting options: Flutter's format names, combined date formats, optional parameters and custom patterns have different semantics. Expressions reference the original variable. Flutter applies its retained metadata after export.

## Export and byte preservation

Without existing files, export writes canonical JSON containing the current messages and retained metadata, retaining stored key order and placing new resource attributes after their resources. With SDK 4's `files` argument, `keepUnchangedJsonEntries` compares entries by canonical import/export meaning and keeps their original bytes. This preserves key order, JSON escape spellings, indentation, BOM, line endings and final newline. Changed entries are rewritten in the surrounding file's style, and returned files are marked `verbatim`.

An unedited ICU spelling can differ from the canonical serializer's spelling; it still stays unchanged on disk. Original message bytes are not embedded in the database. Consequently an export to a new directory preserves meaning and metadata but may canonicalize ICU layout and JSON formatting.

Deleting a message also deletes its `@message` attributes if the message existed at import. Globals and originally orphaned attributes are retained. Deleting every message still exports an empty/metadata-only file so deleted strings cannot reappear on the next load. When all carriers have been removed, known imported existing files supply enough metadata to perform that cleanup.

Output paths include an explicit SDK `metadata.pathPattern` override. This ensures the SDK writes the configured filename spelling even though project locales use BCP 47 tags. New Flutter `@@locale` values use underscores even with BCP 47 filenames, matching Flutter's own filename/attribute consistency check. Canonical locale identities are used for template, message and metadata lookups.

## Boundaries

This is a Flutter ARB file plugin, not a Dart code generator, an ICU runtime, or a parser for JavaScript `arb.register(...)` wrappers. Flutter's generator remains the authority for Dart reserved identifiers, supported formatting methods/parameters, type compatibility and source/translation placeholder signatures. Resource IDs accept lower-case public Dart names including `$`. The plugin validates structural types and message syntax; it preserves unknown attributes instead of restricting extensions to a fixed vocabulary. Generic ARB non-text types inherit from the template and remain literal data; Flutter does not interpret `type: css` as an instruction to bypass its own ICU parser.

Literal HTML stays text. Inlang markup nodes, literal expression arguments, dynamic formatter options, unsupported selector functions, undeclared references, missing fallback variants and duplicate conditions are rejected on export rather than discarded. Non-text resource types bypass message parsing. General ICU mode preserves the ICU1 feature set of the pinned ICU mapper; unsupported complex ICU formatter parameters may still be rejected by that mapper.
