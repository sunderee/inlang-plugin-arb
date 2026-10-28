import fc from "fast-check";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, test } from "vitest";
import { flutterToIcu } from "../src/flutter.js";
import plugin, {
  ArbError,
  createMetadataBundle,
  exportFiles,
  importFiles,
  readMetadataBundle,
} from "../src/index.js";
import { resolveSettings } from "../src/settings.js";
import { evaluateRows, file, importRows, materialize, roundtrip, settings } from "./helpers.js";

describe("Flutter ARB round trips", () => {
  test("generated nested Flutter messages match an independent AST oracle before and after export", async () => {
    type Ast =
      | { kind: "text"; source: string; value: string }
      | { kind: "choice"; variable: string; plural: boolean; yes: Ast; other: Ast };
    const leaf = fc.constantFrom<Ast>(
      { kind: "text", source: "Hello 🌍", value: "Hello 🌍" },
      { kind: "text", source: "It''s # fine", value: "It's # fine" },
      { kind: "text", source: "'{literal}'", value: "{literal}" },
    );
    const trees: (depth: number) => fc.Arbitrary<Ast> = fc.memo<Ast>((depth): fc.Arbitrary<Ast> => {
      if (depth <= 0) return leaf;
      return fc.oneof(
        leaf,
        fc.tuple(fc.boolean(), trees(depth - 1), trees(depth - 1)).map(
          ([plural, yes, other]): Ast => ({
            kind: "choice",
            variable: plural ? `count${depth}` : `kind${depth}`,
            plural,
            yes,
            other,
          }),
        ),
      );
    });
    const encode = (ast: Ast): string =>
      ast.kind === "text"
        ? ast.source
        : `{${ast.variable}, ${ast.plural ? "plural, one" : "select, x"} {${encode(ast.yes)}} other {${encode(ast.other)}}}`;
    const evaluate = (ast: Ast, locale: string, number: number, value: string): string => {
      if (ast.kind === "text") return ast.value;
      const yes = ast.plural
        ? number === 1 || new Intl.PluralRules(locale).select(number) === "one"
        : value === "x";
      return evaluate(yes ? ast.yes : ast.other, locale, number, value);
    };
    const leafBudget = (ast: Ast): number =>
      ast.kind === "text" ? 1 : (ast.plural ? 2 : 1) * leafBudget(ast.yes) + leafBudget(ast.other);
    await fc.assert(
      fc.asyncProperty(trees(2), async (ast) => {
        const documents = [{ generated: encode(ast) }, { generated: encode(ast) }];
        const rows = importRows(documents, { useEscaping: true }, ["en", "sl"]);
        const bounded = importRows(documents, { useEscaping: true, maxVariants: leafBudget(ast) }, [
          "en",
          "sl",
        ]);
        for (const message of bounded.messages)
          expect(
            bounded.variants.filter((variant) => variant.messageId === message.id).length,
          ).toBeLessThanOrEqual(leafBudget(ast));
        const outputs = await exportFiles(rows);
        const imported = materialize(importFiles({ files: outputs, settings: rows.settings }));
        for (const locale of ["en", "sl"])
          for (const number of [0, 1, 2, 3, 101])
            for (const value of ["x", "unknown"]) {
              const inputs = { count1: number, count2: number, kind1: value, kind2: value };
              const expected = evaluate(ast, locale, number, value);
              expect(evaluateRows(rows, "generated", locale, inputs)).toBe(expected);
              expect(
                evaluateRows({ ...imported, settings: rows.settings }, "generated", locale, inputs),
              ).toBe(expected);
            }
      }),
      { numRuns: 100, seed: 927151 },
    );
  });
  test.each([
    "{n, plural, one {A {n, plural, one {B} other {C}}} other {D}}",
    "{n, plural, one {One} other {Many}} / {n, plural, zero {Zero} other {Something}}",
    "{gender, select, male {{gender, select, male {He} other {Unreachable}}} other {They}}",
  ])("correlated nested and repeated selectors preserve behavior: %s", async (source) => {
    const [output] = await roundtrip([{ correlated: source }]);
    const config = resolveSettings(settings());
    for (const locale of ["en", "fr", "ar", "sl"])
      for (const n of [0, 1, 2, 3, 11, 21, 101, 1.5])
        for (const gender of ["male", "x", "unknown"]) {
          const expected = new IntlMessageFormat(
            flutterToIcu(source, config, new Set()),
            locale,
          ).format({ n, gender });
          const actual = new IntlMessageFormat(
            flutterToIcu(String(output?.["correlated"]), config, new Set()),
            locale,
          ).format({ n, gender });
          expect(actual).toBe(expected);
        }
  });
  test("literal hashes inside a select inside a plural survive canonical export", async () => {
    const source =
      "{n, plural, =0 {Zero} =2 {Two} other {{gender, select, x {# literal} other {# other}}}}";
    const [output] = await roundtrip([{ nested: source }]);
    const normalized = flutterToIcu(
      String(output?.["nested"]),
      resolveSettings(settings()),
      new Set(),
    );
    for (const n of [0, 1, 2, 3, 11])
      for (const gender of ["x", "unknown"]) {
        const expected =
          n === 0 ? "Zero" : n === 2 ? "Two" : gender === "x" ? "# literal" : "# other";
        expect(new IntlMessageFormat(normalized, "en").format({ n, gender })).toBe(expected);
      }
  });

  test("plain, empty, Unicode, HTML, backslashes and JSON escape sequences", async () => {
    const document = {
      "@@locale": "en",
      title: "Hello 🌍 — مرحبًا 中文",
      empty: "",
      html: "<b>hello</b> & <icon/>",
      slashes: 'C:\\new\\file\n\t"',
      apostrophe: "It's Flutter's world",
      hash: "# is literal",
    };
    expect(await roundtrip([document])).toEqual([document]);
  });

  test("interpolations and repeated placeholders are declarations and expressions", async () => {
    const rows = importRows([{ hello: "Hello {name} and {name} ({age})" }]);
    expect(rows.bundles.find((bundle) => bundle.id === "hello")?.declarations).toEqual([
      { type: "input-variable", name: "name" },
      { type: "input-variable", name: "age" },
    ]);
    expect(rows.variants[0]?.pattern.filter((part) => part.type === "expression")).toHaveLength(3);
    expect(await roundtrip([{ hello: "Hello {name} and {name} ({age})" }])).toEqual([
      { hello: "Hello {name} and {name} ({age})" },
    ]);
  });

  test("preserves every metadata field, extensions, types and ordering", async () => {
    const document = {
      "@@locale": "en_US",
      "@@context": "home",
      "@@last_modified": "2026-10-28",
      "@@custom": { nested: [true, null, 42] },
      price: "Price: {price}",
      "@price": {
        description: "A price",
        context: "store",
        type: "text",
        source_text: "Price: {price}",
        screen: "data:image/png;base64,abc",
        x_vendor: { flag: false },
        placeholders: {
          price: {
            type: "double",
            format: "compactCurrency",
            example: "10.5",
            optionalParameters: { decimalDigits: 2, name: "EUR", symbol: "€" },
          },
        },
      },
      date: "{date}",
      "@date": {
        placeholders: {
          date: {
            type: "DateTime",
            format: "yyyy-MM-dd",
            isCustomDateFormat: true,
          },
        },
      },
      "@orphan": { description: "preserve orphan attributes" },
    };
    const roundtripped = await roundtrip([document], {}, ["en-US"]);
    expect(roundtripped).toEqual([document]);
    expect(Object.keys(roundtripped[0] ?? {})).toEqual(Object.keys(document));
    const imported = importRows([document], {}, ["en-US"]);
    const carrier = imported.bundles.find((bundle) => bundle.id.startsWith("@inlang/arb/"));
    expect(carrier).toBeDefined();
    expect(imported.messages).toHaveLength(2);
    if (carrier === undefined) throw new Error("Missing carrier");
    const meta = readMetadataBundle(carrier);
    meta.attributes["@@context"] = "edited";
    expect(readMetadataBundle(carrier).attributes["@@context"]).toBe("home");
    imported.bundles[imported.bundles.indexOf(carrier)] = createMetadataBundle(meta);
    const [output] = await exportFiles(imported);
    expect(JSON.parse(new TextDecoder().decode(output?.content)) as unknown).toMatchObject({
      "@@context": "edited",
    });
  });

  test("all CLDR categories and exact plural cases preserve behavior", async () => {
    const source =
      "Cart: {count, plural, =0 {Empty} =1 {Exactly one} zero {Zero} one {One} two {Two} few {Few} many {Many} other {{count} things}}!";
    const [output] = await roundtrip([{ cart: source }]);
    const exported = output?.["cart"];
    expect(typeof exported).toBe("string");
    const config = resolveSettings(settings());
    for (const locale of ["en", "fr", "ar", "sl", "ru"]) {
      for (const count of [0, 1, 2, 3, 4, 5, 11, 21, 101, 1.5]) {
        const expected = new IntlMessageFormat(
          flutterToIcu(source, config, new Set()),
          locale,
        ).format({ count });
        const actual = new IntlMessageFormat(
          flutterToIcu(String(exported), config, new Set()),
          locale,
        ).format({ count });
        expect(actual).toBe(expected);
      }
    }
  });

  test("nested and adjacent selectors, literal # and apostrophes", async () => {
    const source =
      "Hi {gender, select, male {{count, plural, =0 {No #} one {His # {count}} other {His # {count} items}}} other {{count, plural, one {Their # item} other {Their # {count} items}}}}. {status, select, yes {It's done} other {It's pending}}";
    const [output] = await roundtrip([{ message: source }]);
    const config = resolveSettings(settings());
    for (const gender of ["male", "female", "other"])
      for (const count of [0, 1, 2, 21])
        for (const status of ["yes", "no"]) {
          const values = { gender, count, status };
          const normalize = (text: string) =>
            new IntlMessageFormat(flutterToIcu(text, config, new Set()), "en").format(values);
          expect(normalize(String(output?.["message"]))).toEqual(normalize(source));
        }
  });

  test("different locale selector shapes cannot overwrite declarations", async () => {
    const rows = importRows([
      { count: "{n, plural, one {One} other {{n}}}" },
      {
        count: "{n, select, yes {Ja {nPlural__arb_en}} other {Nein {nPlural__arb_en}}}",
        another: "{nPlural}",
      },
    ]);
    const exported = await exportFiles(rows);
    expect(exported).toHaveLength(2);
    const reimported = {
      ...materialize(importFiles({ files: exported, settings: rows.settings })),
      settings: rows.settings,
    };
    expect(evaluateRows(reimported, "count", "en", { n: 1 })).toBe("One");
    expect(evaluateRows(reimported, "count", "en", { n: 3 })).toBe("3");
    expect(evaluateRows(reimported, "count", "de", { n: "yes", nPlural__arb_en: "safe" })).toBe(
      "Ja safe",
    );
    expect(evaluateRows(reimported, "count", "de", { n: "unknown", nPlural__arb_en: "safe" })).toBe(
      "Nein safe",
    );
    expect(evaluateRows(reimported, "another", "de", { nPlural: "preserved" })).toBe("preserved");
  });

  test("Flutter inline date/time skeletons", async () => {
    const model = importRows([{ date: "{when, date, ::yMMMMd} at {when, time, ::Hm}" }]);
    expect(model.variants[0]?.pattern.filter((part) => part.type === "expression")).toMatchObject([
      { arg: { name: "when" }, annotation: { name: "date" } },
      { arg: { name: "when" }, annotation: { name: "time" } },
    ]);
    expect(await roundtrip([{ date: "{when, date, ::yMMMMd} at {when, time, ::Hm}" }])).toEqual([
      { date: "{when, date, ::yMMMMd} at {when, time, ::Hm}" },
    ]);
  });

  test("Flutter use-escaping handles quotes around arbitrary text, braces and apostrophes", async () => {
    const cases = [
      "Hello! '{Isn''t}' this a wonderful day?",
      "'ordinary words' {name}",
      "''",
      "'{}'",
      "a''b",
      "'{'name'}'",
      "'{''}'",
      "'{''}{'",
      "'{' '}'",
    ];
    for (const source of cases) {
      const [output] = await roundtrip([{ greeting: source }], {
        useEscaping: true,
      });
      const config = resolveSettings(settings({ useEscaping: true }));
      expect(flutterToIcu(String(output?.["greeting"]), config, new Set())).toBe(
        flutterToIcu(source, config, new Set()),
      );
    }
  });

  test("relaxed syntax uses template placeholders, including translations with no metadata", async () => {
    const documents = [
      {
        hello: "JSON {literal} plus {name} }",
        "@hello": { placeholders: { name: {} } },
      },
      { hello: "JSON {literal} mit {name} }" },
    ];
    const outputs = await roundtrip(documents, { useRelaxedSyntax: true });
    expect(outputs).toEqual(documents);
  });

  test("preserves non-text resource strings without ICU interpretation", async () => {
    const document = {
      css: "#footer {margin: 2px;}",
      "@css": { type: "css" },
      image: "data:image/svg+xml,{<svg/>}",
      "@image": { type: "image" },
    };
    expect(await roundtrip([document])).toEqual([document]);
  });

  test("empty files and global-only files survive without any messages", async () => {
    expect(await roundtrip([{}, { "@@locale": "de", "@@context": "empty" }])).toEqual([
      {},
      { "@@locale": "de", "@@context": "empty" },
    ]);
  });

  test("ICU mode handles offsets, ordinal, pound, formatter styles and general resource IDs", async () => {
    const document = {
      "rank.label": "{rank, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
      count: "{n, plural, offset:1 =0 {None} other {# others}}",
      date: "{date, date, long}",
      price: "{price, number, ::currency/USD}",
    };
    const [output] = await roundtrip([document], { syntax: "icu" });
    expect(Object.keys(output ?? {})).toEqual(Object.keys(document));
    for (const rank of [1, 2, 3, 4, 11, 21]) {
      expect(
        new IntlMessageFormat(String(output?.["rank.label"]), "en").format({
          rank,
        }),
      ).toEqual(new IntlMessageFormat(document["rank.label"], "en").format({ rank }));
    }
  });

  test("arbitrary Unicode literal text property round trip", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((value) => !/[{}]/.test(value)),
        async (value) => {
          expect(await roundtrip([{ text: value }])).toEqual([{ text: value }]);
        },
      ),
      { numRuns: 250, seed: 62824 },
    );
  });

  test("arbitrary literal text with Flutter escaping property round trip", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .array(fc.constantFrom("a", "é", "🚀", "{", "}", "'", "#", "\n", "\\"), { maxLength: 50 })
          .map((parts) => parts.join("")),
        async (text) => {
          const rows = importRows([{ text: "" }], { useEscaping: true });
          const variant = rows.variants[0];
          if (variant === undefined) throw new Error("Missing variant");
          variant.pattern = [{ type: "text", value: text }];
          const exported = await exportFiles(rows);
          const reimported = importFiles({
            files: exported,
            settings: rows.settings,
          });
          expect(
            reimported.variants[0]?.pattern
              ?.map((part) => (part.type === "text" ? part.value : "EXPR"))
              .join(""),
          ).toBe(text);
        },
      ),
      { numRuns: 250, seed: 62824 },
    );
  });
});

describe("file discovery and validation", () => {
  test("uses underscore filenames and project BCP47 locales", () => {
    expect(
      plugin.toBeImportedFiles({
        settings: settings({}, ["en-US", "zh-Hant-TW"]),
      }),
    ).toEqual([
      { locale: "en-US", path: "./lib/l10n/app_en_US.arb" },
      { locale: "zh-Hant-TW", path: "./lib/l10n/app_zh_Hant_TW.arb" },
    ]);
    expect(
      plugin.toBeImportedFiles({
        settings: settings({ pathPattern: "./arb/{locale}.arb", localeFormat: "bcp47" }, ["pt-BR"]),
      }),
    ).toEqual([{ locale: "pt-BR", path: "./arb/pt-BR.arb" }]);
  });

  test.each([
    ["[1]", "JSON object"],
    ["null", "JSON object"],
    ["{}{}", "Invalid JSON"],
    ['{"x":"a",}', "Invalid JSON"],
    ['{/*x*/"x":"a"}', "Invalid JSON"],
    ['{"x":"a","x":"b"}', "Duplicate JSON key"],
    ['{"x":"a","@x":{"a":1,"a":2}}', "Duplicate JSON key"],
    ['{"x":12}', "must be strings"],
    ['{"x":null}', "must be strings"],
    ['{"x":"{name"}', "Expected"],
    ['{"x":"foo}"}', "closing brace"],
    ['{"x":"{n, plural, one {x}}"}', "other case"],
    ['{"x":"{n, plural, =7 {x} other {y}}"}', "only exact plural"],
    ['{"x":"{n, plural, bad {x} other {y}}"}', "Invalid plural category"],
    ['{"x":"{n, plural, =x {x} other {y}}"}', "exact plural number"],
    ['{"x":"{n, plural, offset:1 other {x}}"}', "does not support plural offsets"],
    ['{"x":"{n, selectordinal, other {x}}"}', "does not support"],
    ['{"x":"{n, number, compact}"}', "does not support"],
    ['{"x":"{d, date, long}"}', "::skeleton"],
    ['{"x":"{!}"}', "identifier"],
    ['{"x":"{n, select, ! {x} other {y}}"}', "select/plural case"],
    ['{"x":"a","@x":null}', "attribute object"],
    ['{"x":"a","@x":{"description":1}}', "must be a string"],
    ['{"x":"a","@x":{"placeholders":[]}}', "must be an object"],
    ['{"x":"a","@x":{"placeholders":{"name":null}}}', "must be an object"],
    ['{"x":"a","@x":{"placeholders":{"name":{"type":1}}}}', "must be a string"],
    ['{"x":"a","@x":{"placeholders":{"name":{"isCustomDateFormat":"yes"}}}}', "must be a boolean"],
    ['{"x":"a","@x":{"placeholders":{"name":{"optionalParameters":[]}}}}', "must be an object"],
    ['{"x":"a","@x":{"placeholders":{"bad-name":{}}}}', "Invalid placeholder"],
    ['{"@@locale":"de","x":"a"}', "does not match"],
    ['{"@@locale":42}', "must be a string"],
    ['{"":"a"}', "cannot be empty"],
    ['{"_private":"a"}', "Dart identifiers"],
  ])("rejects %s with context", (source, diagnostic) => {
    expect(() => importRows([source])).toThrow(diagnostic);
    expect(() => importRows([source])).toThrow("app_en.arb");
  });

  test("rejects invalid UTF8 and accepts a UTF8 BOM", () => {
    expect(() =>
      importFiles({
        files: [{ locale: "en", content: new Uint8Array([0xc3, 0x28]) }],
        settings: settings(),
      }),
    ).toThrow("UTF-8");
    expect(importRows(['\uFEFF{"hello":"world"}']).messages).toHaveLength(1);
  });

  test("rejects unconfigured and duplicate file locales", () => {
    expect(() => importFiles({ files: [file("fr", {})], settings: settings() })).toThrow(
      "not configured",
    );
    expect(() =>
      importFiles({
        files: [file("en", {}), file("en", {})],
        settings: settings(),
      }),
    ).toThrow("duplicate file locale");
  });

  test("rejects unmatched apostrophes only with escaping enabled", () => {
    expect(() => importRows([{ x: "It's broken" }], { useEscaping: true })).toThrow(
      "Unmatched single quote",
    );
    expect(importRows([{ x: "It's fine" }]).variants).toHaveLength(1);
  });

  test("variant expansion is bounded before materialization", () => {
    const source = "{a, select, x {X} other {A}}{b, select, y {Y} other {B}}";
    expect(() => importRows([{ x: source }], { maxVariants: 3 })).toThrow("maxVariants");
  });

  test("guards nesting and nonfinite JSON numbers", () => {
    expect(() => importRows(['{"@@data":1e999}'])).toThrow("finite");
    expect(() => importRows([`{"@@data":${"[".repeat(70)}0${"]".repeat(70)}}`])).toThrow("nesting");
    const nested = `${"{n, select, other {".repeat(34)}x${"}}".repeat(34)}`;
    expect(() => importRows([{ x: nested }])).toThrow("nesting");
  });

  test("ArbError exposes a stable diagnostic name", () => {
    expect(new ArbError("message").name).toBe("ArbError");
  });
});
