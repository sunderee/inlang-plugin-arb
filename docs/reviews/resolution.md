# Claude Code review: actions and verification

The user requested an independent test/code-quality review through the installed `claude` CLI. Claude Code 2.1.312 reviewed an immutable pre-refactor snapshot with read-only Read/Glob/Grep tools, no shell execution, no writes and no delegated agents. Its original feedback is retained unchanged in [claude-original.md](claude-original.md). It did not run tests; the implementation and verification below were performed afterward in this project.

## Confirmed findings addressed

| Review ID | Change | Evidence |
| --- | --- | --- |
| P1 | Reject missing as well as divergent numeric/category pairs, in either direction. Exact-only editor data cannot silently widen into a Flutter category. | Six missing-pair cases, paired edits and divergent edits in `tests/review-regressions.test.ts`; actual edited plural compilation in `scripts/test-flutter.mjs` |
| P2 | Canonical locale identity now drives template, message and metadata lookups, including re-spelled existing locales. | Relaxed base-locale case/underscore regression and metadata/selector preservation across locale respelling |
| P3 | Carriers record optional key order; canonical exports retain it and new attributes follow resources. Older carriers remain supported. | Exact canonical-byte assertion, explicit `Object.keys` assertions, new-message ordering checks |
| P5 | Literal validation considers template placeholders as well as input declarations. Generated metadata is limited to real base messages; target-only expressions cannot rely on a phantom template. | Literal collision with an unused template placeholder, escaped recovery, target-only relaxed-mode rejection |
| P6 | Resource types inherit from base metadata when translations omit attributes. | Two-locale non-text round trip and model declaration assertion |
| P7 | JSON depth counts actual containers; metadata parsing permits the additional carrier container. Parsing remains iterative at the JSON boundary. | Exact 64/65-container boundary, 10,000-container rejection, maximal valid metadata import/export |
| P9, property order | Variant signatures normalize selector/match values rather than serializing arbitrary object property order. Missing and explicit catchalls normalize consistently. | Reordered match-object and omitted-catchall duplicate regressions |
| H4, confirmed against Flutter source | Public resource IDs support `$` and reject leading uppercase letters, matching Flutter's generator. | Unit assertions and compilation/access of a generated `$price` getter |
| H5, confirmed against Flutter source | BCP 47 filenames are allowed, but newly generated Flutter `@@locale` values use underscores so Flutter's filename/attribute consistency check passes. | Unit filename/global assertion and generated regional localization lookup in the native edited-data test |

Other changes consolidate plural alias definitions, settings defaults and literal-resource detection; remove the redundant global-regex test; provide specific diagnostics for unsupported offsets and non-string `@@locale`; and index variants by bundle for placeholder inference rather than scanning all messages for each input.

## Test quality changes

- A generated-AST property test uses an independent evaluator for displayed text and for inlang selector matching. It checks imported and reimported models across English and Slovenian inputs without running both expected and actual values through `flutterToIcu`.
- Generated trees also test an independently calculated source-leaf expansion bound against actual mapper output. This supplements the defensive post-mapping check; bounds remain conservative, not a general CPU/memory sandbox for arbitrary third-party code.
- Date/time and relaxed-locale tests assert expression/declaration shapes; metadata tests assert key order explicitly.
- The locale-shape test now creates an actual input/local-name collision within the same bundle and checks rendered values in both locales, rather than just searching output for the words `plural` and `select`.
- SDK tests persist plural local declarations and both numeric/category variants through a close/reopen snapshot, then check edited exports.
- Multi-locale relaxed-mode byte preservation is tested with an edit only in the target locale. The SDK's helper imports previous files together, so H2 was not reproduced as a bug.
- Native Flutter testing now changes persisted SDK rows, edits both plural branches, creates date/plural/string resources with inferred metadata, deletes a resource and its attributes, renames another resource, and exports with previous file bytes. Flutter then compiles and executes the edited result, including a regional catalog with a BCP 47 filename. The original unedited conformance and relaxed-mode phases remain.
- Local JSON/ICU replacements have dedicated malformed-input, quoting, duplicate-key, Unicode, exact-depth and generated-data tests.

## Deliberate boundaries and clarifications

- **P4:** unknown stored message locales still cause an export error. Silently excluding them can hide data left behind by an accidental settings change. Delete/migrate those messages explicitly before removing a locale. This policy is documented and tested.
- **H3:** the SDK replaces shared bundle declarations on import. The plugin import interface has no access to existing database declarations, so related locale catalogs must be imported as a complete batch. A real SDK regression demonstrates the failure of a partial plural import and recovery with the complete batch. This existing API constraint remains explicit in the documentation.
- **P9, newly authored metadata:** `ArbFileMetadata.keys` distinguishes resource attributes from intentionally orphaned attributes. Tools manually adding metadata for a newly authored resource must add its ID to `keys`. This responsibility is documented and tested; the plugin does not guess whether arbitrary orphan attributes were intentional.
- A literal match for the string `other` is not intrinsically equivalent to a catchall in the inlang model. The property-order fix does not conflate those two meanings.
- Generic ARB non-text resources remain literal data. Flutter's generator does not interpret their `type` as an escape hatch from its ICU grammar; CSS with raw braces is therefore not presented as a compilable Flutter message.
- **H6:** literal closing braces inside nested relaxed choices remain constrained by Flutter's own grammar. This refactor does not invent an escaping convention that Flutter cannot parse; use `useEscaping` for such literals.
- **Snapshot scope:** the original review listed a missing build config, license, lint config and lockfile as conditional concerns. Those existed in the working project but were not copied into the review snapshot. They were not missing repository files; clean installation, build and package-loader checks verify the actual project.

The coverage thresholds were retained. High coverage is treated as evidence about exercised code, alongside independent semantic oracles, actual SDK persistence and actual Flutter execution.
