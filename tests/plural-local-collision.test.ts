import type { ParsedMessage } from "@inlang/plugin-icu1";
import fc from "fast-check";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, test } from "vitest";
import { exportFiles, importFiles } from "../src/index.js";
import { namespaceLocals, validateModel } from "../src/model.js";
import { evaluateRows, file, importRows, materialize, roundtrip, settings } from "./helpers.js";

type Rows = ReturnType<typeof importRows>;
type ExportedFiles = Awaited<ReturnType<typeof exportFiles>>;

const reproduction = "{n, plural, one {One} other {Many}} {nPlural}";

function helloModel(rows: Rows, locale = "en") {
  const bundle = rows.bundles.find((entry) => entry.id === "hello");
  const message = rows.messages.find(
    (entry) => entry.bundleId === "hello" && entry.locale === locale,
  );
  if (bundle === undefined || message === undefined) throw new Error("Missing hello model");
  const variants = rows.variants.filter((entry) => entry.messageId === message.id);
  expect(variants.length).toBeGreaterThan(0);
  return { bundle, message, variants };
}

function expectLocal(rows: Rows, originalName: string, input: string, locale = "en") {
  const { bundle, message, variants } = helloModel(rows, locale);
  const local = bundle.declarations.find(
    (declaration) =>
      declaration.type === "local-variable" &&
      new RegExp(`^${originalName}__arb_${locale}_*$`).test(declaration.name),
  );
  expect(local).toBeDefined();
  if (local?.type !== "local-variable") throw new Error(`Missing local for ${originalName}`);
  expect(local.value.arg).toEqual({ type: "variable-reference", name: input });
  expect(
    bundle.declarations.some(
      (entry) => entry.type === "input-variable" && entry.name === local.name,
    ),
  ).toBe(false);
  expect(new Set(bundle.declarations.map((entry) => entry.name)).size).toBe(
    bundle.declarations.length,
  );
  expect(message.selectors).toContainEqual({ type: "variable-reference", name: local.name });
  expect(message.selectors).not.toContainEqual({ type: "variable-reference", name: originalName });
  for (const variant of variants) {
    expect(variant.matches.map((match) => match.key)).toContain(local.name);
    expect(variant.matches.map((match) => match.key)).not.toContain(originalName);
    expect(
      variant.matches.every((match) =>
        message.selectors.some((selector) => selector.name === match.key),
      ),
    ).toBe(true);
  }
  return local;
}

function expectPatternInputs(rows: Rows, names: string[], locale = "en") {
  const { bundle, variants } = helloModel(rows, locale);
  for (const name of names) {
    expect(bundle.declarations).toContainEqual({ type: "input-variable", name });
  }
  for (const variant of variants) {
    const expressions = variant.pattern.filter((part) => part.type === "expression");
    expect(expressions.map((part) => part.arg)).toEqual(
      names.map((name) => ({ type: "variable-reference", name })),
    );
  }
}

function exportedHello(files: ExportedFiles, locale = "en"): string {
  const exported = files.find((entry) => entry.locale === locale);
  expect(exported).toBeDefined();
  const document = JSON.parse(new TextDecoder().decode(exported?.content)) as Record<
    string,
    unknown
  >;
  const source = document["hello"];
  expect(typeof source).toBe("string");
  if (typeof source !== "string") throw new Error("Missing exported hello string");
  return source;
}

function expectPlaceholder(source: string, name: string) {
  expect(source).toContain(`{${name}}`);
  expect(source).not.toContain(`{${name}__arb_`);
}

async function exportAndReimport(rows: Rows) {
  const files = await exportFiles(rows);
  expect(files.length).toBeGreaterThan(0);
  const reimported = {
    ...materialize(importFiles({ files, settings: rows.settings })),
    settings: rows.settings,
  };
  return { files, reimported };
}

describe("issue #2: generated plural locals must not steal input placeholders", () => {
  test.each([
    { n: 2, expected: "Many Label" },
    { n: 1, expected: "One Label" },
  ])("the exact reproduction evaluates n=$n as $expected", ({ n, expected }) => {
    const rows = importRows([{ hello: reproduction }]);
    expect(evaluateRows(rows, "hello", "en", { n, nPlural: "Label" })).toBe(expected);
  });

  test("the exact reproduction exports, retains {nPlural}, and reimports without corruption", async () => {
    const rows = importRows([{ hello: reproduction }]);
    const exporting = exportFiles(rows);
    await expect(exporting).resolves.toHaveLength(1);
    const files = await exporting;
    expectPlaceholder(exportedHello(files), "nPlural");
    const reimported = {
      ...materialize(importFiles({ files, settings: rows.settings })),
      settings: rows.settings,
    };
    expectPatternInputs(reimported, ["nPlural"]);
    expect(evaluateRows(reimported, "hello", "en", { n: 2, nPlural: "Label" })).toBe("Many Label");
    expect(evaluateRows(reimported, "hello", "en", { n: 1, nPlural: "Label" })).toBe("One Label");
    const [document] = await roundtrip([{ hello: reproduction }]);
    expect(document?.["hello"]).toContain("{nPlural}");
    expect(document?.["hello"]).not.toContain("{nPlural__arb_en}");
  });

  test("the model separates input expressions from plural selectors and validates for export", async () => {
    const rows = importRows([{ hello: reproduction }]);
    const local = expectLocal(rows, "nPlural", "n");
    const exact = expectLocal(rows, "nPluralExact", "n");
    expect(local.value.annotation).toEqual({
      type: "function-reference",
      name: "plural",
      options: [],
    });
    expect(exact.value.annotation).toBeUndefined();
    const { bundle, message, variants } = helloModel(rows);
    expect(message.selectors).toEqual([
      { type: "variable-reference", name: exact.name },
      { type: "variable-reference", name: local.name },
    ]);
    expect(variants).toHaveLength(3);
    expectPatternInputs(rows, ["nPlural"]);
    for (const variant of variants) {
      expect(variant.pattern.at(-1)).toEqual({
        type: "expression",
        arg: { type: "variable-reference", name: "nPlural" },
      });
      expect(variant.matches.map((match) => match.key)).toEqual([exact.name, local.name]);
    }
    expect(validateModel(bundle, message, variants, 100)).toEqual(new Set(["n", "nPlural"]));
    await expect(exportFiles(rows)).resolves.toHaveLength(1);
  });

  test("ICU pound stays annotated on n while the colliding interpolation stays an input", async () => {
    const source = "{n, plural, one {#} other {# items}} {nPlural}";
    const rows = importRows([{ hello: source }], { syntax: "icu" });
    const check = (model: Rows) => {
      expectLocal(model, "nPlural", "n");
      expectPatternInputs(model, ["n", "nPlural"]);
      const { variants } = helloModel(model);
      expect(variants).toHaveLength(2);
      for (const variant of variants) {
        expect(variant.pattern[0]).toEqual({
          type: "expression",
          arg: { type: "variable-reference", name: "n" },
          annotation: { type: "function-reference", name: "icu:pound", options: [] },
        });
        expect(variant.pattern.at(-1)).toEqual({
          type: "expression",
          arg: { type: "variable-reference", name: "nPlural" },
        });
      }
      expect(evaluateRows(model, "hello", "en", { n: 2, nPlural: "Label" })).toBe("2 items Label");
      expect(evaluateRows(model, "hello", "en", { n: 1, nPlural: "Label" })).toBe("1 Label");
    };
    check(rows);
    const { files, reimported } = await exportAndReimport(rows);
    check(reimported);
    const exported = exportedHello(files);
    expect(exported).toContain("#");
    expectPlaceholder(exported, "nPlural");
    expect(new IntlMessageFormat(exported, "en").format({ n: 2, nPlural: "Label" })).toBe(
      "2 items Label",
    );
  });

  test("interpolations inside every plural body refer to the input", async () => {
    const rows = importRows([{ hello: "{n, plural, one {{nPlural}} other {{nPlural}}}" }]);
    expectLocal(rows, "nPlural", "n");
    expectPatternInputs(rows, ["nPlural"]);
    for (const n of [1, 2]) {
      expect(evaluateRows(rows, "hello", "en", { n, nPlural: "X" })).toBe("X");
    }
    const { files, reimported } = await exportAndReimport(rows);
    expectPlaceholder(exportedHello(files), "nPlural");
    expectPatternInputs(reimported, ["nPlural"]);
    for (const n of [1, 2]) {
      expect(evaluateRows(reimported, "hello", "en", { n, nPlural: "X" })).toBe("X");
    }
  });

  test("adjacent plurals preserve both colliding inputs across all branch combinations", async () => {
    const source =
      "{foo, plural, one {A} other {B}} {bar, plural, one {C} other {D}} {fooPlural} {barPlural}";
    const rows = importRows([{ hello: source }]);
    expectLocal(rows, "fooPlural", "foo");
    expectLocal(rows, "barPlural", "bar");
    expectPatternInputs(rows, ["fooPlural", "barPlural"]);
    const check = (model: Rows) => {
      for (const foo of [1, 2]) {
        for (const bar of [1, 2]) {
          const inputs = { foo, bar, fooPlural: "F", barPlural: "B" };
          const expected = new IntlMessageFormat(source, "en").format(inputs);
          expect(evaluateRows(model, "hello", "en", inputs)).toBe(expected);
        }
      }
      expect(
        evaluateRows(model, "hello", "en", { foo: 2, bar: 1, fooPlural: "F", barPlural: "B" }),
      ).toBe("B C F B");
    };
    check(rows);
    const { files, reimported } = await exportAndReimport(rows);
    expectPlaceholder(exportedHello(files), "fooPlural");
    expectPlaceholder(exportedHello(files), "barPlural");
    expectPatternInputs(reimported, ["fooPlural", "barPlural"]);
    check(reimported);
  });

  test("countPlural is an input even when count generates a plural local", async () => {
    const rows = importRows([{ hello: "{count, plural, one {One} other {Many}} {countPlural}" }]);
    expectLocal(rows, "countPlural", "count");
    expectPatternInputs(rows, ["countPlural"]);
    const check = (model: Rows) => {
      expect(evaluateRows(model, "hello", "en", { count: 2, countPlural: "Label" })).toBe(
        "Many Label",
      );
      expect(evaluateRows(model, "hello", "en", { count: 1, countPlural: "Label" })).toBe(
        "One Label",
      );
    };
    check(rows);
    const { files, reimported } = await exportAndReimport(rows);
    expectPlaceholder(exportedHello(files), "countPlural");
    expectPatternInputs(reimported, ["countPlural"]);
    check(reimported);
  });

  test("Flutter's generated exact-branch local cannot steal nPluralExact", async () => {
    const rows = importRows([{ hello: "{n, plural, one {One} other {Many}} {nPluralExact}" }]);
    expectLocal(rows, "nPlural", "n");
    const exact = expectLocal(rows, "nPluralExact", "n");
    expect(exact.value.annotation).toBeUndefined();
    expectPatternInputs(rows, ["nPluralExact"]);
    const check = (model: Rows) => {
      expect(evaluateRows(model, "hello", "en", { n: 2, nPluralExact: "Label" })).toBe(
        "Many Label",
      );
      expect(evaluateRows(model, "hello", "en", { n: 1, nPluralExact: "Label" })).toBe("One Label");
    };
    check(rows);
    const { files, reimported } = await exportAndReimport(rows);
    expectPlaceholder(exportedHello(files), "nPluralExact");
    expectLocal(reimported, "nPluralExact", "n");
    expectPatternInputs(reimported, ["nPluralExact"]);
    check(reimported);
  });

  test("ICU offset selectors cannot steal nPluralOffset1", async () => {
    const source = "{n, plural, offset:1 one {One} other {Many}} {nPluralOffset1}";
    const rows = importRows([{ hello: source }], { syntax: "icu" });
    const check = (model: Rows) => {
      const local = expectLocal(model, "nPluralOffset1", "n");
      expect(local.value.annotation).toEqual({
        type: "function-reference",
        name: "plural",
        options: [{ name: "offset", value: { type: "literal", value: "1" } }],
      });
      expectPatternInputs(model, ["nPluralOffset1"]);
    };
    check(rows);
    const { files, reimported } = await exportAndReimport(rows);
    check(reimported);
    const exported = exportedHello(files);
    expectPlaceholder(exported, "nPluralOffset1");
    expect(exported).toContain("offset:1");
    // evaluateRows does not implement offsets; use ICU semantics for the emitted source.
    expect(new IntlMessageFormat(exported, "en").format({ n: 2, nPluralOffset1: "Label" })).toBe(
      "One Label",
    );
    expect(new IntlMessageFormat(exported, "en").format({ n: 3, nPluralOffset1: "Label" })).toBe(
      "Many Label",
    );
  });

  test("ICU ordinal selectors cannot steal nOrdinal", async () => {
    const source = "{n, selectordinal, one {st} other {th}} {nOrdinal}";
    const rows = importRows([{ hello: source }], { syntax: "icu" });
    const check = (model: Rows) => {
      const local = expectLocal(model, "nOrdinal", "n");
      expect(local.value.annotation).toEqual({
        type: "function-reference",
        name: "plural",
        options: [{ name: "type", value: { type: "literal", value: "ordinal" } }],
      });
      expectPatternInputs(model, ["nOrdinal"]);
    };
    check(rows);
    const { files, reimported } = await exportAndReimport(rows);
    check(reimported);
    const exported = exportedHello(files);
    expectPlaceholder(exported, "nOrdinal");
    expect(exported).toContain("selectordinal");
    // evaluateRows only implements cardinal selection; 21 distinguishes the two.
    for (const n of [1, 21]) {
      expect(new IntlMessageFormat(exported, "en").format({ n, nOrdinal: "Label" })).toBe(
        "st Label",
      );
    }
    for (const n of [2, 11]) {
      expect(new IntlMessageFormat(exported, "en").format({ n, nOrdinal: "Label" })).toBe(
        "th Label",
      );
    }
  });

  test("the union of locale inputs preserves German nPlural without changing English evaluation", async () => {
    const rows = importRows([
      { hello: "{n, plural, one {One} other {Many}}" },
      { hello: "{n, plural, one {Eins} other {Viele}} {nPlural}" },
    ]);
    const check = (model: Rows) => {
      const english = expectLocal(model, "nPlural", "n", "en");
      const german = expectLocal(model, "nPlural", "n", "de");
      expect(english.name).not.toBe(german.name);
      expectPatternInputs(model, [], "en");
      expectPatternInputs(model, ["nPlural"], "de");
      expect(evaluateRows(model, "hello", "en", { n: 2 })).toBe("Many");
      expect(evaluateRows(model, "hello", "en", { n: 1 })).toBe("One");
      expect(evaluateRows(model, "hello", "de", { n: 2, nPlural: "Etikett" })).toBe(
        "Viele Etikett",
      );
      expect(evaluateRows(model, "hello", "de", { n: 1, nPlural: "Etikett" })).toBe("Eins Etikett");
    };
    check(rows);
    const { files, reimported } = await exportAndReimport(rows);
    expect(files.map((entry) => entry.locale)).toEqual(["en", "de"]);
    expectPlaceholder(exportedHello(files, "de"), "nPlural");
    expect(exportedHello(files, "en")).not.toContain("{nPlural}");
    check(reimported);
  });

  test("an input occupying the final namespaced spelling forces a different local name", async () => {
    const rows = importRows([{ hello: "{n, plural, one {One} other {Many}} {nPlural__arb_en}" }]);
    const local = expectLocal(rows, "nPlural", "n");
    expect(local.name).toMatch(/^nPlural__arb_en_+$/);
    expectPatternInputs(rows, ["nPlural__arb_en"]);
    const check = (model: Rows) => {
      expect(evaluateRows(model, "hello", "en", { n: 2, nPlural__arb_en: "Label" })).toBe(
        "Many Label",
      );
      expect(evaluateRows(model, "hello", "en", { n: 1, nPlural__arb_en: "Label" })).toBe(
        "One Label",
      );
    };
    check(rows);
    const { files, reimported } = await exportAndReimport(rows);
    const exported = exportedHello(files);
    expectPlaceholder(exported, "nPlural__arb_en");
    expect(exported).not.toMatch(/\{nPlural__arb_en_+\}/);
    expectLocal(reimported, "nPlural", "n");
    expectPatternInputs(reimported, ["nPlural__arb_en"]);
    check(reimported);
  });

  test("namespaceLocals distinguishes original-name input references from local references", () => {
    const parsed: ParsedMessage = {
      declarations: [
        { type: "input-variable", name: "n" },
        { type: "input-variable", name: "nPlural" },
        {
          type: "local-variable",
          name: "nPlural",
          value: {
            type: "expression",
            arg: { type: "variable-reference", name: "n" },
            annotation: {
              type: "function-reference",
              name: "plural",
              options: [{ name: "offset", value: { type: "variable-reference", name: "nPlural" } }],
            },
          },
        },
      ],
      selectors: [{ type: "variable-reference", name: "nPlural" }],
      variants: [
        {
          messageBundleId: "hello",
          messageLocale: "en",
          matches: [{ type: "literal-match", key: "nPlural", value: "one" }],
          pattern: [{ type: "expression", arg: { type: "variable-reference", name: "nPlural" } }],
        },
        {
          messageBundleId: "hello",
          messageLocale: "en",
          matches: [{ type: "catchall-match", key: "nPlural" }],
          pattern: [{ type: "expression", arg: { type: "variable-reference", name: "nPlural" } }],
        },
      ],
    };
    const before = structuredClone(parsed);
    const namespaced = namespaceLocals(parsed, "en", new Set(["n", "nPlural"]));
    expect(namespaced.declarations).toEqual([
      { type: "input-variable", name: "n" },
      { type: "input-variable", name: "nPlural" },
      {
        type: "local-variable",
        name: "nPlural__arb_en",
        value: {
          type: "expression",
          arg: { type: "variable-reference", name: "n" },
          annotation: {
            type: "function-reference",
            name: "plural",
            options: [
              { name: "offset", value: { type: "variable-reference", name: "nPlural__arb_en" } },
            ],
          },
        },
      },
    ]);
    expect(new Set(namespaced.declarations.map((entry) => entry.name)).size).toBe(3);
    expect(namespaced.selectors).toEqual([{ type: "variable-reference", name: "nPlural__arb_en" }]);
    expect(namespaced.variants.map((variant) => variant.matches)).toEqual([
      [{ type: "literal-match", key: "nPlural__arb_en", value: "one" }],
      [{ type: "catchall-match", key: "nPlural__arb_en" }],
    ]);
    for (const variant of namespaced.variants) {
      expect(variant.pattern).toEqual([
        { type: "expression", arg: { type: "variable-reference", name: "nPlural" } },
      ]);
    }
    expect(parsed).toEqual(before);
  });

  test("generated base identifiers preserve colliding inputs through Flutter import and export", async () => {
    const baseNames = fc.oneof(
      fc.constantFrom("n", "count", "x", "foo"),
      fc.stringMatching(/^[a-z]{1,5}$/),
    );
    await fc.assert(
      fc.asyncProperty(baseNames, async (base) => {
        const input = `${base}Plural`;
        const source = `{${base}, plural, one {One} other {Many}} {${input}}`;
        const rows = importRows([{ hello: source }]);
        expect(evaluateRows(rows, "hello", "en", { [base]: 2, [input]: "L" })).toBe("Many L");
        expect(evaluateRows(rows, "hello", "en", { [base]: 1, [input]: "L" })).toBe("One L");
        expectLocal(rows, input, base);
        expectPatternInputs(rows, [input]);
        const { files, reimported } = await exportAndReimport(rows);
        expectPlaceholder(exportedHello(files), input);
        expectPatternInputs(reimported, [input]);
        expect(evaluateRows(reimported, "hello", "en", { [base]: 2, [input]: "L" })).toBe("Many L");
        expect(evaluateRows(reimported, "hello", "en", { [base]: 1, [input]: "L" })).toBe("One L");
      }),
      { numRuns: 30, seed: 927152 },
    );
  });

  test("relaxed Flutter syntax respects template placeholder metadata in both locales", async () => {
    const project = settings({ useRelaxedSyntax: true });
    const metadata = { placeholders: { n: { type: "num" }, nPlural: { type: "String" } } };
    const rows = {
      ...materialize(
        importFiles({
          settings: project,
          files: [
            file("en", { hello: `${reproduction} {literal}`, "@hello": metadata }),
            file("de", { hello: "{n, plural, one {Eins} other {Viele}} {nPlural} {literal}" }),
          ],
        }),
      ),
      settings: project,
    };
    const check = (model: Rows) => {
      for (const locale of ["en", "de"]) {
        expectLocal(model, "nPlural", "n", locale);
        expectPatternInputs(model, ["nPlural"], locale);
        expect(helloModel(model, locale).bundle.declarations).not.toContainEqual({
          type: "input-variable",
          name: "literal",
        });
      }
      expect(evaluateRows(model, "hello", "en", { n: 2, nPlural: "Label" })).toBe(
        "Many Label {literal}",
      );
      expect(evaluateRows(model, "hello", "en", { n: 1, nPlural: "Label" })).toBe(
        "One Label {literal}",
      );
      expect(evaluateRows(model, "hello", "de", { n: 2, nPlural: "Etikett" })).toBe(
        "Viele Etikett {literal}",
      );
      expect(evaluateRows(model, "hello", "de", { n: 1, nPlural: "Etikett" })).toBe(
        "Eins Etikett {literal}",
      );
    };
    check(rows);
    const { files, reimported } = await exportAndReimport(rows);
    for (const locale of ["en", "de"]) expectPlaceholder(exportedHello(files, locale), "nPlural");
    const document = JSON.parse(new TextDecoder().decode(files[0]?.content)) as Record<
      string,
      unknown
    >;
    expect(document["@hello"]).toEqual(metadata);
    check(reimported);
  });

  test("a non-colliding plural still namespaces its locals and round-trips normally", async () => {
    const rows = importRows([{ hello: "{n, plural, one {One} other {Many}}" }]);
    const local = expectLocal(rows, "nPlural", "n");
    const exact = expectLocal(rows, "nPluralExact", "n");
    expect(local.name).toBe("nPlural__arb_en");
    expect(exact.name).toBe("nPluralExact__arb_en");
    const check = (model: Rows) => {
      expectPatternInputs(model, []);
      expect(evaluateRows(model, "hello", "en", { n: 2 })).toBe("Many");
      expect(evaluateRows(model, "hello", "en", { n: 1 })).toBe("One");
    };
    check(rows);
    const { files, reimported } = await exportAndReimport(rows);
    expect(exportedHello(files)).not.toContain("__arb_");
    expectLocal(reimported, "nPlural", "n");
    check(reimported);
  });

  test("select uses the gender input directly and never invents a genderSelect local", async () => {
    const rows = importRows([{ hello: "{gender, select, male {He} other {They}} {genderSelect}" }]);
    const check = (model: Rows) => {
      const { bundle, message, variants } = helloModel(model);
      expect(bundle.declarations).toEqual([
        { type: "input-variable", name: "gender" },
        { type: "input-variable", name: "genderSelect" },
      ]);
      expect(message.selectors).toEqual([{ type: "variable-reference", name: "gender" }]);
      expect(variants).toHaveLength(2);
      for (const variant of variants)
        expect(variant.matches.map((match) => match.key)).toEqual(["gender"]);
      expectPatternInputs(model, ["genderSelect"]);
      expect(evaluateRows(model, "hello", "en", { gender: "male", genderSelect: "X" })).toBe(
        "He X",
      );
      expect(evaluateRows(model, "hello", "en", { gender: "unknown", genderSelect: "X" })).toBe(
        "They X",
      );
    };
    check(rows);
    const { files, reimported } = await exportAndReimport(rows);
    expectPlaceholder(exportedHello(files), "genderSelect");
    expect(exportedHello(files)).not.toContain("__arb_");
    check(reimported);
  });
});
