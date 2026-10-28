import type { Bundle, Pattern } from "@inlang/sdk";
import { describe, expect, test } from "vitest";
import { errorMessage } from "../src/error.js";
import { icuToFlutter, validateIcu } from "../src/flutter.js";
import {
  ArbError,
  createMetadataBundle,
  exportFiles,
  importFiles,
  readMetadataBundle,
} from "../src/index.js";
import { namespaceLocals } from "../src/model.js";
import { type ArbSettings, canonicalLocale, resolveSettings } from "../src/settings.js";
import { importRows, settings } from "./helpers.js";

describe("settings boundaries", () => {
  test.each([
    { pathPattern: "./no-placeholder.arb" },
    { pathPattern: "{locale}-{locale}.arb" },
    { pathPattern: "./{locale}.json" },
    { pathPattern: "/{locale}.arb" },
    { pathPattern: "C:\\{locale}.arb" },
    { pathPattern: "https://example.com/{locale}.arb" },
    { unknown: true },
    { indentation: -1 },
    { indentation: 9 },
    { indentation: 1.5 },
    { useEscaping: "true" },
    { maxVariants: 0 },
    { maxVariants: 100001 },
    { localeFormat: "bad" },
    { syntax: "bad" },
  ])("rejects invalid configuration %j", (config) => {
    expect(() => resolveSettings(settings(config as unknown as ArbSettings))).toThrow(ArbError);
  });
  test.each(["", "../en", "en/a", "en-a", "abcd-US", "en_123456789"])(
    "rejects malformed locale %s",
    (locale) => {
      expect(() => canonicalLocale(locale)).toThrow("Invalid locale");
    },
  );
  test("rejects equivalent locales and missing base locale", () => {
    expect(() => resolveSettings(settings({}, ["en-US", "en_US"]))).toThrow("equivalent");
    expect(() => resolveSettings({ ...settings(), baseLocale: "fr" })).toThrow("baseLocale");
  });
  test("accepts omitted plugin settings and explicit compact indentation", async () => {
    const rows = importRows([{ hello: "Hi" }], { indentation: 0 });
    const [output] = await exportFiles(rows);
    expect(new TextDecoder().decode(output?.content)).toBe('{"hello":"Hi"}\n');
    expect(resolveSettings({ baseLocale: "en", locales: ["en"], modules: [] }).indentation).toBe(2);
  });
});

describe("metadata integrity", () => {
  test("rejects missing, malformed and unknown carrier versions", () => {
    expect(() => readMetadataBundle({ id: "@inlang/arb/en", declarations: [] })).toThrow(
      "Invalid ARB metadata",
    );
    const carrier = createMetadataBundle({
      version: 1,
      locale: "en",
      keys: [],
      attributes: {},
    });
    const declaration = carrier.declarations[0];
    if (declaration?.type !== "local-variable" || declaration.value.arg.type !== "literal")
      throw new Error("Missing metadata");
    declaration.value.arg.value = '{"version":2,"locale":"en","keys":[],"attributes":{}}';
    expect(() => readMetadataBundle(carrier)).toThrow("unsupported");
  });
  test("edited carrier locale must agree with the ARB locale", async () => {
    const rows = importRows([{ "@@locale": "en", hello: "Hi" }]);
    const carrier = rows.bundles[0];
    if (carrier === undefined) throw new Error("Missing metadata");
    const data = readMetadataBundle(carrier);
    data.attributes["@@locale"] = "de";
    rows.bundles[0] = createMetadataBundle(data);
    await expect(exportFiles(rows)).rejects.toThrow("does not match");
  });
  test("special object keys cannot pollute prototypes", async () => {
    const source =
      '{"__proto__":"safe","constructor":"also safe","@@custom":{"__proto__":{"polluted":true}}}';
    const rows = importRows([source], { syntax: "icu" });
    const [output] = await exportFiles(rows);
    expect(new TextDecoder().decode(output?.content)).toContain('"__proto__"');
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});

describe("model validation prevents silent data loss", () => {
  type Rows = ReturnType<typeof importRows>;
  const rejects = async (mutate: (rows: Rows) => void, diagnostic: string): Promise<void> => {
    const rows = importRows([{ hello: "Hello {name}" }]);
    mutate(rows);
    await expect(exportFiles(rows)).rejects.toThrow(diagnostic);
  };
  const pattern = (rows: Rows, parts: Pattern): void => {
    const variant = rows.variants[0];
    if (variant === undefined) throw new Error("Missing variant");
    variant.pattern = parts;
  };

  test("rejects missing bundle and variant references", async () => {
    await rejects((rows) => {
      rows.bundles = [];
    }, "missing bundle");
    await rejects((rows) => {
      rows.messages = [];
    }, "missing message");
  });
  test("rejects duplicate bundle and message identifiers", async () => {
    await rejects((rows) => {
      const bundle = rows.bundles[0];
      if (bundle !== undefined) rows.bundles.push(bundle);
    }, "Duplicate bundle");
    await rejects((rows) => {
      const message = rows.messages[0];
      if (message !== undefined) rows.messages.push(message);
    }, "Duplicate message IDs");
  });
  test("rejects duplicate locale messages, unknown locales and private resource IDs", async () => {
    await rejects((rows) => {
      const message = rows.messages[0];
      if (message !== undefined) rows.messages.push({ ...message, id: "another" });
    }, "Duplicate messages");
    await rejects((rows) => {
      for (const message of rows.messages) message.locale = "fr";
    }, "not configured");
    await rejects((rows) => {
      for (const message of rows.messages) message.bundleId = "_private";
    }, "Invalid ARB resource ID");
  });
  test("rejects missing variants and undeclared variables", async () => {
    await rejects((rows) => {
      rows.variants = [];
    }, "at least one");
    await rejects((rows) => {
      pattern(rows, [
        {
          type: "expression",
          arg: { type: "variable-reference", name: "unknown" },
        },
      ]);
    }, "Undeclared");
  });
  test("rejects literal expressions and markup", async () => {
    await rejects((rows) => {
      pattern(rows, [{ type: "expression", arg: { type: "literal", value: "literal" } }]);
    }, "Literal expressions");
    await rejects((rows) => {
      pattern(rows, [{ type: "markup-start", name: "b" }]);
    }, "Markup nodes");
  });
  test("rejects dynamic and unsupported formatter options", async () => {
    for (const value of [
      { type: "variable-reference" as const, name: "name" },
      { type: "literal" as const, value: "anything" },
    ]) {
      await rejects(
        (rows) => {
          pattern(rows, [
            {
              type: "expression",
              arg: { type: "variable-reference", name: "name" },
              annotation: {
                type: "function-reference",
                name: "number",
                options: [{ name: "dynamic", value }],
              },
            },
          ]);
        },
        value.type === "literal" ? "Unsupported formatter option" : "Dynamic formatter",
      );
    }
  });
  test("rejects interpolated local aliases", async () => {
    await rejects((rows) => {
      const bundle = rows.bundles.find((entry) => entry.id === "hello");
      bundle?.declarations.push({
        type: "local-variable",
        name: "alias",
        value: {
          type: "expression",
          arg: { type: "variable-reference", name: "name" },
        },
      });
      pattern(rows, [
        {
          type: "expression",
          arg: { type: "variable-reference", name: "alias" },
        },
      ]);
    }, "Local variable interpolation");
  });
  test("rejects duplicate declarations and duplicate matches", async () => {
    await rejects((rows) => {
      rows.bundles
        .find((bundle) => bundle.id === "hello")
        ?.declarations.push({ type: "input-variable", name: "name" });
    }, "Duplicate declaration");
    await rejects((rows) => {
      const variant = rows.variants[0];
      if (variant !== undefined) rows.variants.push({ ...variant, id: "duplicate" });
    }, "Duplicate variant");
  });
  test("rejects duplicate and unrelated selector matches", async () => {
    for (const matches of [
      [{ type: "catchall-match" as const, key: "unrelated" }],
      [
        { type: "catchall-match" as const, key: "name" },
        { type: "catchall-match" as const, key: "name" },
      ],
    ]) {
      await rejects((rows) => {
        const message = rows.messages[0];
        const variant = rows.variants[0];
        if (message !== undefined)
          message.selectors = [{ type: "variable-reference", name: "name" }];
        if (variant !== undefined) variant.matches = matches;
      }, "unique selectors");
    }
  });
  test("requires a fallback and unique selectors", async () => {
    await rejects((rows) => {
      for (const message of rows.messages)
        message.selectors = [{ type: "variable-reference", name: "name" }];
      for (const variant of rows.variants)
        variant.matches = [{ type: "literal-match", key: "name", value: "yes" }];
    }, "fallback");
    await rejects((rows) => {
      for (const message of rows.messages)
        message.selectors = [
          { type: "variable-reference", name: "name" },
          { type: "variable-reference", name: "name" },
        ];
    }, "Duplicate selector");
  });
  test("validates derived selector functions and option values", async () => {
    const selectorBundle = (rows: Rows): Bundle => {
      const bundle = rows.bundles.find((entry) => entry.id === "hello");
      if (bundle === undefined) throw new Error("Missing bundle");
      for (const message of rows.messages)
        message.selectors = [{ type: "variable-reference", name: "derived" }];
      for (const variant of rows.variants)
        variant.matches = [{ type: "catchall-match", key: "derived" }];
      return bundle;
    };
    await rejects((rows) => {
      selectorBundle(rows).declarations.push({
        type: "local-variable",
        name: "derived",
        value: { type: "expression", arg: { type: "literal", value: "x" } },
      });
    }, "directly to input");
    await rejects((rows) => {
      selectorBundle(rows).declarations.push({
        type: "local-variable",
        name: "derived",
        value: {
          type: "expression",
          arg: { type: "variable-reference", name: "name" },
          annotation: {
            type: "function-reference",
            name: "unknown",
            options: [],
          },
        },
      });
    }, "Unsupported selector function");
    for (const [name, value] of [
      ["type", "bad"],
      ["offset", "-1"],
      ["unknown", "1"],
    ]) {
      await rejects(
        (rows) => {
          selectorBundle(rows).declarations.push({
            type: "local-variable",
            name: "derived",
            value: {
              type: "expression",
              arg: { type: "variable-reference", name: "name" },
              annotation: {
                type: "function-reference",
                name: "plural",
                options: [
                  {
                    name: name ?? "",
                    value: { type: "literal", value: value ?? "" },
                  },
                ],
              },
            },
          });
        },
        name === "unknown" ? "Unsupported plural" : "Invalid plural selector",
      );
    }
  });
  test("enforces export variant limits and non-text resource shapes", async () => {
    const rows = importRows([{ x: "{name, select, yes {Yes} other {No}}" }]);
    rows.settings["plugin.inlang.arb"].maxVariants = 1;
    await expect(exportFiles(rows)).rejects.toThrow("maxVariants");
    const literal = importRows([{ css: "body{margin:0}", "@css": { type: "css" } }]);
    const variant = literal.variants[0];
    if (variant !== undefined)
      variant.pattern = [{ type: "expression", arg: { type: "variable-reference", name: "x" } }];
    literal.bundles
      .find((bundle) => bundle.id === "css")
      ?.declarations.push({ type: "input-variable", name: "x" });
    await expect(exportFiles(literal)).rejects.toThrow("only literal");
  });
});

test("Flutter serializer rejects ICU features it cannot represent", () => {
  const config = resolveSettings(settings());
  for (const [source, diagnostic] of [
    ["{n, number}", "inline number"],
    ["{n, date, long}", "inline date"],
    ["{n, plural, other {#}}", "does not substitute"],
    ["{n, selectordinal, other {x}}", "selectordinal"],
    ["{n, plural, offset:1 other {x}}", "offsets"],
    ["{n, plural, =7 {seven} other {x}}", "only exact"],
    ["{n, plural, =1 {exact} one {category} other {x}}", "cannot distinguish"],
    ["'{'", "Literal braces"],
  ])
    expect(() => icuToFlutter(source ?? "", config, new Set())).toThrow(diagnostic);
  expect(icuToFlutter("'{literal}'", { ...config, useRelaxedSyntax: true }, new Set())).toBe(
    "{literal}",
  );
  expect(() =>
    icuToFlutter("'{name}'", { ...config, useRelaxedSyntax: true }, new Set(["name"])),
  ).toThrow("Literal braces");
});

test("ICU profile validates duplicates, missing fallback, nesting and malformed messages", () => {
  expect(() => validateIcu("{n, plural, other {a} other {b}}", 100)).toThrow("Duplicate");
  expect(() => validateIcu("{n, select, yes {a}}", 100)).toThrow("other");
  expect(() => validateIcu(`${"{n, select, other {".repeat(34)}x${"}}".repeat(34)}`, 100)).toThrow(
    "nesting",
  );
  expect(() =>
    importFiles({
      settings: settings({ syntax: "icu" }),
      files: [{ locale: "en", content: new TextEncoder().encode('{"x":"{"}') }],
    }),
  ).toThrow();
});

test("local names and references stay consistent, even with an input name collision", () => {
  const parsed = namespaceLocals(
    {
      declarations: [
        { type: "input-variable", name: "n" },
        {
          type: "local-variable",
          name: "local",
          value: {
            type: "expression",
            arg: { type: "variable-reference", name: "n" },
            annotation: {
              type: "function-reference",
              name: "plural",
              options: [
                {
                  name: "offset",
                  value: { type: "variable-reference", name: "local" },
                },
              ],
            },
          },
        },
      ],
      selectors: [{ type: "variable-reference", name: "local" }],
      variants: [
        {
          messageBundleId: "hello",
          messageLocale: "en",
          matches: [{ type: "catchall-match", key: "local" }],
          pattern: [
            {
              type: "expression",
              arg: { type: "variable-reference", name: "local" },
            },
          ],
        },
      ],
    },
    "en",
    new Set(["n", "local__arb_en"]),
  );
  expect(parsed.selectors[0]?.name).toBe("local__arb_en_");
  expect(parsed.variants[0]?.matches?.[0]?.key).toBe("local__arb_en_");
  expect(parsed.variants[0]?.pattern?.[0]).toMatchObject({
    arg: { name: "local__arb_en_" },
  });
});

test("unknown error values receive useful messages", () => {
  expect(errorMessage("problem")).toBe("problem");
  expect(errorMessage(123)).toBe("123");
});
