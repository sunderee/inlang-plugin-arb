import { describe, expect, test } from "vitest";
import { icuToFlutter } from "../src/flutter.js";
import {
  createMetadataBundle,
  exportFiles,
  importFiles,
  readMetadataBundle,
} from "../src/index.js";
import { resolveSettings } from "../src/settings.js";
import { file, importRows, materialize, roundtrip, settings } from "./helpers.js";

describe("Claude review regressions", () => {
  test.each([
    "=0 {Exact}",
    "=1 {Exact}",
    "=2 {Exact}",
    "zero {Category}",
    "one {Category}",
    "two {Category}",
  ])("rejects unpaired Flutter plural branch %s instead of widening its meaning", (branch) => {
    expect(() =>
      icuToFlutter(`{n, plural, ${branch} other {Other}}`, resolveSettings(settings()), new Set()),
    ).toThrow("both patterns must be present and agree");
  });

  test("editing both numeric/category variants works; editing one is rejected", async () => {
    const rows = importRows([{ count: "{n, plural, one {One} other {Other}}" }]);
    const one = rows.variants.filter((variant) =>
      variant.pattern.some((part) => part.type === "text" && part.value === "One"),
    );
    expect(one).toHaveLength(2);
    for (const variant of one) variant.pattern = [{ type: "text", value: "Edited one" }];
    const [output] = await exportFiles(rows);
    expect(new TextDecoder().decode(output?.content)).toContain("Edited one");
    const first = one[0];
    if (first === undefined) throw new Error("Missing exact variant");
    first.pattern = [{ type: "text", value: "Divergent" }];
    await expect(exportFiles(rows)).rejects.toThrow("cannot distinguish");
  });

  test("base-locale spelling is canonicalized before relaxed template lookup", async () => {
    const project = { ...settings({ useRelaxedSyntax: true }, ["en-US"]), baseLocale: "en-us" };
    const imported = importFiles({
      settings: project,
      files: [file("en_US", { hello: "Hello {name}", "@hello": { placeholders: { name: {} } } })],
    });
    expect(imported.messages[0]?.locale).toBe("en-US");
    expect(imported.variants[0]?.pattern).toContainEqual({
      type: "expression",
      arg: { type: "variable-reference", name: "name" },
    });
    const [output] = await exportFiles({ ...materialize(imported), settings: project });
    expect(new TextDecoder().decode(output?.content)).toContain("Hello {name}");
  });

  test("respelling a project locale retains descriptions, types and plural selectors", async () => {
    const document = {
      "@@locale": "zh_Hant_TW",
      count: "{n, plural, one {One} other {Other}}",
      "@count": { description: "Keep me", placeholders: { n: { type: "num" } } },
    };
    const rows = importRows([document], {}, ["zh-hant-tw"]);
    rows.settings.locales = ["zh-Hant-TW"];
    rows.settings.baseLocale = "zh-Hant-TW";
    const [output] = await exportFiles(rows);
    expect(output?.locale).toBe("zh-Hant-TW");
    expect(JSON.parse(new TextDecoder().decode(output?.content)) as unknown).toMatchObject({
      "@@locale": "zh_Hant_TW",
      "@count": document["@count"],
    });
  });

  test("canonical exports preserve original key order and new attributes follow their resources", async () => {
    const source =
      '{"@@locale":"en","hello":"Hi","@hello":{"description":"Greeting"},"next":"Bye","@next":{}}';
    const rows = importRows([source], { indentation: 0 });
    const [output] = await exportFiles(rows);
    expect(new TextDecoder().decode(output?.content)).toBe(`${source}\n`);
    const fresh = rows.bundles.filter((bundle) => !/^@inlang\/arb\//.test(bundle.id));
    const [created] = await exportFiles({ ...rows, bundles: fresh });
    expect(Object.keys(JSON.parse(new TextDecoder().decode(created?.content)) as object)).toEqual([
      "@@locale",
      "hello",
      "next",
    ]);
    const newRows = importRows([{ hello: "Hi {name}" }]);
    newRows.bundles = newRows.bundles.filter((bundle) => !/^@inlang\/arb\//.test(bundle.id));
    const [generated] = await exportFiles(newRows);
    expect(Object.keys(JSON.parse(new TextDecoder().decode(generated?.content)) as object)).toEqual(
      ["@@locale", "hello", "@hello"],
    );
  });

  test("relaxed literal text cannot collide with an unused template placeholder", async () => {
    const rows = importRows([{ hello: "Hi", "@hello": { placeholders: { foo: {} } } }], {
      useRelaxedSyntax: true,
    });
    const variant = rows.variants[0];
    if (variant === undefined) throw new Error("Missing variant");
    variant.pattern = [{ type: "text", value: "{foo}" }];
    await expect(exportFiles(rows)).rejects.toThrow("Literal braces require");
    rows.settings["plugin.inlang.arb"].useEscaping = true;
    const outputs = await exportFiles(rows);
    const imported = importFiles({ files: outputs, settings: rows.settings });
    expect(imported.variants[0]?.pattern).toEqual([{ type: "text", value: "{foo}" }]);
  });

  test("target-only inputs cannot rely on generated metadata for a missing base message", async () => {
    const rows = importRows([{}, { hello: "Hi {name}", "@hello": { placeholders: { name: {} } } }]);
    rows.settings["plugin.inlang.arb"].useRelaxedSyntax = true;
    await expect(exportFiles(rows)).rejects.toThrow("existing base-locale message");
  });

  test("non-text resource types are inherited from the template", async () => {
    const documents = [{ css: "a{b}", "@css": { type: "css" } }, { css: "c{d}" }];
    const rows = importRows(documents);
    expect(rows.bundles.find((bundle) => bundle.id === "css")?.declarations).toEqual([]);
    expect(await roundtrip(documents)).toEqual(documents);
  });

  test("deep valid ARB metadata remains exportable through its carrier wrapper", async () => {
    const source = `{"@@data":${'{"a":'.repeat(63)}0${"}".repeat(63)},"hello":"Hi"}`;
    const [output] = await exportFiles(importRows([source]));
    expect(JSON.parse(new TextDecoder().decode(output?.content)) as unknown).toEqual(
      JSON.parse(source),
    );
  });

  test("duplicate match detection ignores object property order and omitted catchalls", async () => {
    const rows = importRows([{ hello: "{name, select, x {X} other {Other}}" }]);
    const variant = rows.variants.find((candidate) =>
      candidate.matches.some((match) => match.type === "literal-match"),
    );
    if (variant === undefined) throw new Error("Missing variant");
    rows.variants.push({
      ...variant,
      id: "duplicate",
      matches: [{ value: "x", key: "name", type: "literal-match" }],
    });
    await expect(exportFiles(rows)).rejects.toThrow("Duplicate variant");
    rows.variants.pop();
    const fallback = rows.variants.find((candidate) =>
      candidate.matches.every((match) => match.type === "catchall-match"),
    );
    if (fallback === undefined) throw new Error("Missing fallback");
    rows.variants.push({ ...fallback, id: "duplicate", matches: [] });
    await expect(exportFiles(rows)).rejects.toThrow("Duplicate variant");
  });

  test("multi-locale relaxed files keep bytes while only a target translation changes", async () => {
    const sources = [
      '{"hello":"Hello {name}","@hello":{"placeholders":{"name":{}}}}\n',
      '{\r\n\t"hello": "Hallo {name}"\r\n}\r\n',
    ];
    const rows = importRows(sources, { useRelaxedSyntax: true });
    const target = rows.messages.find((message) => message.locale === "de");
    const variant = rows.variants.find((candidate) => candidate.messageId === target?.id);
    if (variant === undefined) throw new Error("Missing target");
    variant.pattern = [
      { type: "text", value: "Guten Tag " },
      { type: "expression", arg: { type: "variable-reference", name: "name" } },
    ];
    const files = sources.map((source, index) => ({
      locale: index === 0 ? "en" : "de",
      path: `./lib/l10n/app_${index === 0 ? "en" : "de"}.arb`,
      content: new TextEncoder().encode(source),
      imported: true,
    }));
    const outputs = await exportFiles({ ...rows, files });
    expect(new TextDecoder().decode(outputs[0]?.content)).toBe(sources[0]);
    expect(new TextDecoder().decode(outputs[1]?.content)).toBe(
      sources[1]?.replace(/Hallo/, "Guten Tag"),
    );
    expect(outputs.every((output) => output.verbatim)).toBe(true);
  });

  test("accepts Flutter dollar identifiers and rejects uppercase resource names", async () => {
    expect(await roundtrip([{ $price: "Price", hello$world: "Hi" }])).toEqual([
      { $price: "Price", hello$world: "Hi" },
    ]);
    expect(() => importRows([{ Uppercase: "Invalid" }])).toThrow("public Dart identifiers");
  });

  test("BCP47 filenames still generate Flutter's required underscore locale attribute", async () => {
    const rows = importRows([{ hello: "Hi" }], { localeFormat: "bcp47" }, ["en-US"]);
    rows.bundles = rows.bundles.filter((bundle) => !/^@inlang\/arb\//.test(bundle.id));
    const [output] = await exportFiles(rows);
    expect(output?.name).toBe("app_en-US.arb");
    expect(JSON.parse(new TextDecoder().decode(output?.content)) as unknown).toMatchObject({
      "@@locale": "en_US",
    });
  });

  test("metadata added for a new resource tracks that resource for later deletion", async () => {
    const rows = importRows([{ hello: "Hi" }]);
    const carrier = rows.bundles[0];
    if (carrier === undefined) throw new Error("Missing metadata");
    const metadata = readMetadataBundle(carrier);
    metadata.keys.push("newMessage");
    metadata.attributes["@newMessage"] = { description: "A newly authored resource" };
    rows.bundles[0] = createMetadataBundle(metadata);
    const [output] = await exportFiles(rows);
    expect(JSON.parse(new TextDecoder().decode(output?.content)) as object).not.toHaveProperty(
      "@newMessage",
    );
  });
});
