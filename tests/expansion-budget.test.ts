import { describe, expect, test } from "vitest";
import { ArbError } from "../src/error.js";
import { flutterToIcu, validateIcu } from "../src/flutter.js";
import { type IcuPart, parseIcu } from "../src/icu.js";
import { exportFiles, importFiles } from "../src/index.js";
import { type ArbSettings, resolveSettings } from "../src/settings.js";
import { file, importRows, settings } from "./helpers.js";

const config = (overrides: ArbSettings = {}) => resolveSettings(settings(overrides));

function nestedPlural(depth: number, leaf = "x", other = "x"): string {
  let source = leaf;
  for (let i = 0; i < depth; i++) source = `{n${i}, plural, one {${source}} other {${other}}}`;
  return source;
}

// Count the emitted ICU tree, independently of Flutter's alias handling. Empty
// messages are leaves too; cases add and adjacent choices form a Cartesian product.
function variantCount(parts: IcuPart[]): number {
  return parts.reduce(
    (product, part) =>
      product *
      (part.type === "choice"
        ? part.cases.reduce((sum, entry) => sum + variantCount(entry.parts), 0)
        : 1),
    1,
  );
}

function expectBudgetError(action: () => unknown, maxVariants: number): ArbError {
  let returned = false;
  let error: unknown;
  try {
    action();
    returned = true;
  } catch (cause) {
    error = cause;
  }
  // In particular, flutterToIcu must never return a large string for validation
  // by its caller. Checking only importFiles would miss that original bug.
  expect(returned).toBe(false);
  expect(error).toBeInstanceOf(ArbError);
  expect(error).toHaveProperty("message", expect.stringContaining(`maxVariants (${maxVariants})`));
  return error as ArbError;
}

function expectFastBudgetError(action: () => unknown, maxVariants: number): ArbError {
  const start = performance.now();
  const error = expectBudgetError(action, maxVariants);
  // Generous scheduling/coverage allowance; the offset assertions below also
  // catch delayed validation without depending on machine speed.
  expect(performance.now() - start).toBeLessThan(500);
  return error;
}

describe("Flutter conversion expansion budget: issue #1", () => {
  test.each([12, 8])("rejects the %i-deep alias nest inside flutterToIcu", (depth) => {
    const source = nestedPlural(depth);
    const error = expectFastBudgetError(
      () => flutterToIcu(source, config({ maxVariants: 1 }), new Set()),
      1,
    );
    // The first innermost plural already needs three variants. Its closing
    // offset proves we stopped before reading or emitting the outer cases.
    const firstChoiceEnd = source.indexOf(nestedPlural(1)) + nestedPlural(1).length;
    expect(error.message).toContain(`at offset ${firstChoiceEnd}`);
    expect(firstChoiceEnd).toBeLessThan(source.length);
  });

  test.each([12, 8])(
    "rejects the %i-deep alias nest through importFiles and importRows",
    (depth) => {
      const source = nestedPlural(depth);
      const project = settings({ maxVariants: 1 }, ["en"]);
      const files = [file("en", { hostile: source })];
      for (const action of [
        () => importFiles({ files, settings: project }),
        () => importRows([{ hostile: source }], { maxVariants: 1 }, ["en"]),
      ]) {
        const error = expectFastBudgetError(action, 1);
        expect(error.message).toContain('app_en.arb (en), message "hostile"');
        expect(error.cause).toBeInstanceOf(ArbError);
        const firstChoiceEnd = source.indexOf(nestedPlural(1)) + nestedPlural(1).length;
        expect(error.cause).toHaveProperty(
          "message",
          expect.stringContaining(`at offset ${firstChoiceEnd}`),
        );
      }
    },
  );

  test("a small legal conversion returns short ICU; the illegal deep conversion returns nothing", () => {
    const small = flutterToIcu(nestedPlural(1), config({ maxVariants: 3 }), new Set());
    expect(small).toBe("{n0, plural, =1 {x} one {x} other {x}}");
    expect(small.length).toBeLessThan(100);
    expect(variantCount(parseIcu(small, 3))).toBe(3);
    expectFastBudgetError(
      () => flutterToIcu(nestedPlural(12), config({ maxVariants: 3 }), new Set()),
      3,
    );
  });

  test("rejects at the first over-budget plural before scanning an invalid suffix", () => {
    const prefix = nestedPlural(2);
    const error = expectBudgetError(
      () => flutterToIcu(`${prefix}{!`, config({ maxVariants: 6 }), new Set()),
      6,
    );
    expect(error.message).toContain(`at offset ${prefix.length}`);
  });

  test("rejects adjacent multiplication even when both choices fit separately", () => {
    const select = "{g, select, x {A} other {B}}";
    const plural = "{n, plural, one {C} other {D}}";
    const budget = config({ maxVariants: 5 });
    expect(variantCount(parseIcu(flutterToIcu(select, budget, new Set()), 5))).toBe(2);
    expect(variantCount(parseIcu(flutterToIcu(plural, budget, new Set()), 5))).toBe(3);
    const prefix = select + plural;
    const error = expectBudgetError(() => flutterToIcu(`${prefix}{!`, budget, new Set()), 5);
    expect(error.message).toContain(`at offset ${prefix.length}`);
  });
});

const boundaryCases = [
  {
    name: "empty text is one leaf",
    source: "",
    icu: "",
    count: 1,
  },
  {
    name: "text, arguments and formatters do not multiply",
    source: "🌍 {name} {when, date, ::yMd} {when, time, ::Hm}",
    icu: "🌍 {name} {when, date, ::yMd} {when, time, ::Hm}",
    count: 1,
  },
  {
    name: "fallback-only nested choices fit the settings minimum",
    source: "{n, plural, other {{g, select, other {}}}}",
    icu: "{n, plural, other {{g, select, other {}}}}",
    count: 1,
  },
  {
    name: "one plus other includes an exact alias",
    source: "{n, plural, one {A} other {B}}",
    icu: "{n, plural, =1 {A} one {A} other {B}}",
    count: 3,
  },
  {
    name: "all three alias categories count twice",
    source: "{n, plural, zero {Z} one {O} two {T} other {B}}",
    icu: "{n, plural, =0 {Z} =1 {O} =2 {T} zero {Z} one {O} two {T} other {B}}",
    count: 7,
  },
  {
    name: "all three exacts also emit category branches",
    source: "{n, plural, =0 {Z} =1 {O} =2 {T} other {B}}",
    icu: "{n, plural, =0 {Z} =1 {O} =2 {T} zero {Z} one {O} two {T} other {B}}",
    count: 7,
  },
  {
    name: "mixed exacts and categories preserve case order",
    source: "{n, plural, two {T} =0 {Z} =1 {O} few {F} many {M} other {B}}",
    icu: "{n, plural, =0 {Z} =1 {O} =2 {T} two {T} zero {Z} one {O} few {F} many {M} other {B}}",
    count: 9,
  },
  {
    name: "few and many have no alias extras",
    source: "{n, plural, few {F} many {M} other {B}}",
    icu: "{n, plural, few {F} many {M} other {B}}",
    count: 3,
  },
  {
    name: "selects have no alias extras",
    source: "{g, select, x {A} other {B}}",
    icu: "{g, select, x {A} other {B}}",
    count: 2,
  },
  {
    name: "select keys named after plural aliases are still ordinary cases",
    source: "{g, select, zero {Z} one {O} two {T} other {B}}",
    icu: "{g, select, zero {Z} one {O} two {T} other {B}}",
    count: 4,
  },
  {
    name: "numeric select keys have no alias extras",
    source: "{g, select, 0 {Z} 1 {O} 2 {T} other {B}}",
    icu: "{g, select, 0 {Z} 1 {O} 2 {T} other {B}}",
    count: 4,
  },
  {
    name: "adjacent selects multiply to four",
    source: "{g, select, x {A} other {B}}{h, select, y {C} other {D}}",
    icu: "{g, select, x {A} other {B}}{h, select, y {C} other {D}}",
    count: 4,
  },
  {
    name: "select then plural multiplies to six",
    source: "{g, select, x {A} other {B}} / {n, plural, one {C} other {D}}",
    icu: "{g, select, x {A} other {B}} / {n, plural, =1 {C} one {C} other {D}}",
    count: 6,
  },
  {
    name: "plural then select also multiplies to six",
    source: "{n, plural, one {A} other {B}}{g, select, x {C} other {D}}",
    icu: "{n, plural, =1 {A} one {A} other {B}}{g, select, x {C} other {D}}",
    count: 6,
  },
  {
    name: "adjacent plurals multiply to nine",
    source: "{n, plural, one {A} other {B}}{m, plural, two {C} other {D}}",
    icu: "{n, plural, =1 {A} one {A} other {B}}{m, plural, =2 {C} two {C} other {D}}",
    count: 9,
  },
  {
    name: "plural in an aliased body adds as two times three plus one",
    source: "{n, plural, one {{m, plural, one {A} other {B}}} other {C}}",
    icu: "{n, plural, =1 {{m, plural, =1 {A} one {A} other {B}}} one {{m, plural, =1 {A} one {A} other {B}}} other {C}}",
    count: 7,
  },
  {
    name: "plural in a fallback body is not doubled",
    source: "{n, plural, one {A} other {{m, plural, one {B} other {C}}}}",
    icu: "{n, plural, =1 {A} one {A} other {{m, plural, =1 {B} one {B} other {C}}}}",
    count: 5,
  },
  {
    name: "select in an aliased plural body adds as two times two plus one",
    source: "{n, plural, one {{g, select, x {A} other {B}}} other {C}}",
    icu: "{n, plural, =1 {{g, select, x {A} other {B}}} one {{g, select, x {A} other {B}}} other {C}}",
    count: 5,
  },
  {
    name: "plural in a select adds as three plus one",
    source: "{g, select, x {{n, plural, one {A} other {B}}} other {C}}",
    icu: "{g, select, x {{n, plural, =1 {A} one {A} other {B}}} other {C}}",
    count: 4,
  },
  {
    name: "mixed nesting and adjacency multiply after adding cases",
    source:
      "{g, select, x {{n, plural, one {A} other {B}}{h, select, y {C} other {D}}} other {E}}{m, plural, two {F} other {G}}",
    icu: "{g, select, x {{n, plural, =1 {A} one {A} other {B}}{h, select, y {C} other {D}}} other {E}}{m, plural, =2 {F} two {F} other {G}}",
    count: 21,
  },
  {
    name: "repeated selectors still use the conservative Cartesian bound",
    source: "{n, plural, one {A} other {B}}{n, plural, one {C} other {D}}",
    icu: "{n, plural, =1 {A} one {A} other {B}}{n, plural, =1 {C} one {C} other {D}}",
    count: 9,
  },
  {
    name: "empty identical plural bodies are still distinct branches",
    source: "{n, plural, one {} other {}}",
    icu: "{n, plural, =1 {} one {} other {}}",
    count: 3,
  },
  {
    name: "empty identical select bodies are still distinct branches",
    source: "{g, select, x {} other {}}",
    icu: "{g, select, x {} other {}}",
    count: 2,
  },
  {
    name: "last category wins over a more expensive exact body",
    source: "{n, plural, =1 {{g, select, x {discarded X} other {discarded Y}}} one {A} other {B}}",
    icu: "{n, plural, =1 {A} one {A} other {B}}",
    count: 3,
  },
  {
    name: "last exact wins and its surviving nested body is counted twice",
    source: "{n, plural, one {discarded} =1 {{g, select, x {A} other {B}}} other {C}}",
    icu: "{n, plural, =1 {{g, select, x {A} other {B}}} one {{g, select, x {A} other {B}}} other {C}}",
    count: 5,
  },
];

describe("Flutter budget agrees exactly with the emitted ICU", () => {
  test.each(boundaryCases)("$name (budget $count)", ({ source, icu, count }) => {
    // Default-budget conversion also locks the pre-fix legal output byte for byte.
    const converted = flutterToIcu(source, config(), new Set());
    expect(converted).toBe(icu);
    const parts = parseIcu(converted, 100000);
    expect(variantCount(parts)).toBe(count);
    expect(parseIcu(converted, count)).toEqual(parts);
    expect(validateIcu(converted, count)).toEqual(parts);
    expect(flutterToIcu(source, config({ maxVariants: count }), new Set())).toBe(icu);
    if (count > 1) {
      expectBudgetError(
        () => flutterToIcu(source, config({ maxVariants: count - 1 }), new Set()),
        count - 1,
      );
      expectBudgetError(() => parseIcu(converted, count - 1), count - 1);
      expectBudgetError(() => validateIcu(converted, count - 1), count - 1);
    }
  });

  test.each([
    ["zero", "=0"],
    ["one", "=1"],
    ["two", "=2"],
  ])("%s and %s share one surviving body and two emitted branches", (category, exact) => {
    const expected = `{n, plural, ${exact} {A} ${category} {A} other {B}}`;
    for (const cases of [
      `${category} {A}`,
      `${exact} {A}`,
      `${exact} {discarded} ${category} {A}`,
      `${category} {discarded} ${exact} {A}`,
      `${exact} {discarded} ${category} {also discarded} ${exact} {A}`,
    ]) {
      const source = `{n, plural, ${cases} other {B}}`;
      expect(flutterToIcu(source, config(), new Set())).toBe(expected);
      expect(flutterToIcu(source, config({ maxVariants: 3 }), new Set())).toBe(expected);
      expect(variantCount(parseIcu(expected, 3))).toBe(3);
      expectBudgetError(() => flutterToIcu(source, config({ maxVariants: 2 }), new Set()), 2);
    }
  });
});

describe("hostile expansion shapes and quoting", () => {
  test("all three aliases at every level are rejected before their sixfold expansion", () => {
    let source = "🌍";
    for (let i = 0; i < 8; i++) {
      source = `{n${i}, plural, zero {${source}} one {${source}} two {${source}} other {x}}`;
    }
    // Unbounded conversion would duplicate each recursive body six times.
    expect(source.length).toBeLessThan(1000000);
    const error = expectFastBudgetError(
      () => flutterToIcu(source, config({ maxVariants: 1 }), new Set()),
      1,
    );
    const innermost = "{n0, plural, zero {🌍} one {🌍} two {🌍} other {x}}";
    expect(error.message).toContain(`at offset ${source.indexOf(innermost) + innermost.length}`);
    expectFastBudgetError(() => importRows([{ hostile: source }], { maxVariants: 1 }), 1);
  });

  test("adjacent nested plurals hit the product bound at its exact boundary", () => {
    const nested = nestedPlural(4); // 2 * (2 * (2 * 3 + 1) + 1) + 1 = 31.
    const source = `${nested} / ${nested}`;
    const converted = flutterToIcu(source, config({ maxVariants: 31 * 31 }), new Set());
    expect(variantCount(parseIcu(converted, 31 * 31))).toBe(31 * 31);
    expectBudgetError(
      () => flutterToIcu(source, config({ maxVariants: 31 * 31 - 1 }), new Set()),
      31 * 31 - 1,
    );
    const hostile = `${nestedPlural(8)} / ${nestedPlural(12)}`;
    expectFastBudgetError(() => flutterToIcu(hostile, config({ maxVariants: 1 }), new Set()), 1);
    expectFastBudgetError(() => importRows([{ hostile }], { maxVariants: 1 }), 1);
  });

  test.each(["", " \n\t", "🌍 中文 مرحبًا", "It''s '{literal}' and ''#''"])(
    "body %j cannot bypass the budget through emptiness, Unicode or quoting",
    (leaf) => {
      const source = nestedPlural(12, leaf, "");
      const overrides = { maxVariants: 1, useEscaping: true };
      expectFastBudgetError(() => flutterToIcu(source, config(overrides), new Set()), 1);
      expectFastBudgetError(() => importRows([{ hostile: source }], overrides), 1);
    },
  );

  test("escaping preserves the legal output at the exact boundary", () => {
    const source = "{n, plural, one {It''s 🌍} other {'{literal}' #}}";
    const icu = "{n, plural, =1 {It''s 🌍} one {It''s 🌍} other {'{'literal'}' '#'}}";
    expect(flutterToIcu(source, config({ useEscaping: true }), new Set())).toBe(icu);
    expect(flutterToIcu(source, config({ useEscaping: true, maxVariants: 3 }), new Set())).toBe(
      icu,
    );
    expect(variantCount(validateIcu(icu, 3))).toBe(3);
    expectBudgetError(
      () => flutterToIcu(source, config({ useEscaping: true, maxVariants: 2 }), new Set()),
      2,
    );
  });

  test("relaxed syntax still expands declared plural placeholders", () => {
    const placeholders = new Set(Array.from({ length: 12 }, (_, i) => `n${i}`));
    const source = nestedPlural(12);
    const overrides = { useRelaxedSyntax: true, maxVariants: 1 };
    expectFastBudgetError(() => flutterToIcu(source, config(overrides), placeholders), 1);
    expectFastBudgetError(
      () =>
        importRows(
          [
            {
              hostile: source,
              "@hostile": {
                placeholders: Object.fromEntries(
                  [...placeholders].map((name) => [name, { type: "num" }]),
                ),
              },
            },
          ],
          overrides,
        ),
      1,
    );

    const small = "{n0, plural, one {A} other {B}}";
    expect(flutterToIcu(small, config({ useRelaxedSyntax: true }), placeholders)).toBe(
      "{n0, plural, =1 {A} one {A} other {B}}",
    );
    expect(
      flutterToIcu(small, config({ useRelaxedSyntax: true, maxVariants: 3 }), placeholders),
    ).toBe("{n0, plural, =1 {A} one {A} other {B}}");
    expectBudgetError(
      () => flutterToIcu(small, config({ useRelaxedSyntax: true, maxVariants: 2 }), placeholders),
      2,
    );
  });
});

describe("public import/export budget boundaries", () => {
  test("ICU syntax uses its own case count without Flutter alias duplication", () => {
    const source = nestedPlural(12);
    // ICU counts 12 one branches plus the final fallback: 13 leaves. Flutter
    // would count 2 ** 13 - 1 = 8191 after alias duplication.
    expect(variantCount(parseIcu(source, 13))).toBe(13);
    expect(validateIcu(source, 13)).toEqual(parseIcu(source, 13));
    const rows = importRows([{ nested: source }], { syntax: "icu", maxVariants: 13 }, ["en"]);
    expect(rows.messages).toHaveLength(1);
    expect(rows.variants).toHaveLength(13);
    expect(
      new Set(
        rows.variants.flatMap((variant) =>
          variant.matches.flatMap((match) => (match.type === "literal-match" ? [match.value] : [])),
        ),
      ),
    ).toEqual(new Set(["one"]));
    expectBudgetError(() => parseIcu(source, 12), 12);
    expectBudgetError(
      () => importRows([{ nested: source }], { syntax: "icu", maxVariants: 12 }),
      12,
    );
    expectFastBudgetError(() => importRows([{ nested: source }], { maxVariants: 13 }), 13);
    expectFastBudgetError(() => importRows([{ nested: source }]), 4096);
  });

  test.each([
    ["{n, plural, one {A} other {B}}", 3],
    ["{g, select, x {A} other {B}}{n, plural, one {C} other {D}}", 6],
    [nestedPlural(2), 7],
  ] as const)("export rechecks %s at its legal budget %i", async (source, count) => {
    const rows = importRows([{ message: source }], { maxVariants: count }, ["en"]);
    expect(rows.variants).toHaveLength(count);
    const exported = await exportFiles(rows);
    const imported = importFiles({ files: exported, settings: rows.settings });
    expect(imported.variants).toHaveLength(count);

    for (const maxVariants of [count - 1, 1]) {
      rows.settings["plugin.inlang.arb"].maxVariants = maxVariants;
      const pending = exportFiles(rows);
      await expect(pending).rejects.toBeInstanceOf(ArbError);
      await expect(pending).rejects.toThrow(`maxVariants (${maxVariants})`);
    }
  });
});
