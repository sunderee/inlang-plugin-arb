import { expect, test } from "vitest";
import { exportFiles } from "../src/index.js";
import { importRows } from "./helpers.js";

test.each([
  '{ "hello" : "Hello", "@hello" : {"description":"A greeting"}, "next": "Bye" }',
  '{\r\n\t"hello": "Hello",\r\n\t"next": "Bye"\r\n}\r\n',
  '\uFEFF{\n    "hello": "\\u0048ello",\n    "next": "Bye"\n}\n',
  '{"hello":"Hello","next":"Bye"}',
  '{\n  "cart": "{n,plural,=0{None}other{{n} items}}",\n  "next": "Bye"\n}\n',
])("a no-op export preserves every byte: %s", async (source) => {
  const rows = importRows([source]);
  const outputs = await exportFiles({
    ...rows,
    files: [
      {
        path: "./lib/l10n/app_en.arb",
        locale: "en",
        content: new TextEncoder().encode(source),
        imported: true,
      },
    ],
  });
  expect(outputs[0]?.verbatim).toBe(true);
  expect(new TextDecoder("utf8", { ignoreBOM: true }).decode(outputs[0]?.content)).toBe(source);
});

test("editing one translation preserves all other entry bytes and CRLF", async () => {
  const source =
    '{\r\n\t"hello" : "Hello",\r\n\t"next" : "\\u0042ye",\r\n\t"@hello": { "description" : "Keep this" }\r\n}\r\n';
  const rows = importRows([source]);
  const variant = rows.variants[0];
  if (variant === undefined) throw new Error("Missing variant");
  variant.pattern = [{ type: "text", value: "Edited" }];
  const [output] = await exportFiles({
    ...rows,
    files: [
      {
        path: "./lib/l10n/app_en.arb",
        locale: "en",
        content: new TextEncoder().encode(source),
        imported: true,
      },
    ],
  });
  expect(new TextDecoder().decode(output?.content)).toBe(source.replace('"Hello"', '"Edited"'));
});

test("deleting messages deletes associated attributes but keeps globals and orphan attributes", async () => {
  const source =
    '{\n  "@@locale": "en",\n  "hello": "Hi",\n  "@hello": { "description": "Hi" },\n  "@orphan": {}\n}\n';
  const rows = importRows([source]);
  rows.messages = [];
  rows.variants = [];
  const [output] = await exportFiles({
    ...rows,
    files: [
      {
        path: "./lib/l10n/app_en.arb",
        locale: "en",
        content: new TextEncoder().encode(source),
        imported: true,
      },
    ],
  });
  expect(JSON.parse(new TextDecoder().decode(output?.content)) as unknown).toEqual({
    "@@locale": "en",
    "@orphan": {},
  });
});

test("deleting all bundles still empties imported files", async () => {
  const source = '{"hello":"Hi","@hello":{"description":"Hi"},"@@locale":"en"}';
  const rows = importRows([source]);
  rows.bundles = [];
  rows.messages = [];
  rows.variants = [];
  const [output] = await exportFiles({
    ...rows,
    files: [
      {
        path: "./lib/l10n/app_en.arb",
        locale: "en",
        content: new TextEncoder().encode(source),
        imported: true,
      },
    ],
  });
  expect(JSON.parse(new TextDecoder().decode(output?.content)) as unknown).toEqual({
    "@@locale": "en",
  });
});

test("new messages generate Flutter placeholder metadata and resolve the right filename", async () => {
  const [output] = await exportFiles({
    settings: { baseLocale: "pt-BR", locales: ["pt-BR"], modules: [] },
    bundles: [{ id: "hello", declarations: [{ type: "input-variable", name: "name" }] }],
    messages: [{ id: "message", bundleId: "hello", locale: "pt-BR", selectors: [] }],
    variants: [
      {
        id: "variant",
        messageId: "message",
        matches: [],
        pattern: [
          { type: "text", value: "Olá " },
          {
            type: "expression",
            arg: { type: "variable-reference", name: "name" },
          },
        ],
      },
    ],
  });
  expect(output?.name).toBe("app_pt_BR.arb");
  expect(output?.metadata).toEqual({ pathPattern: "./lib/l10n/app_pt_BR.arb" });
  expect(JSON.parse(new TextDecoder().decode(output?.content)) as unknown).toEqual({
    "@@locale": "pt_BR",
    hello: "Olá {name}",
    "@hello": { placeholders: { name: { type: "String" } } },
  });
});

test("new keys and deleted keys are reflected when preserving existing files", async () => {
  const source = '{"hello":"Hi","next":"Bye"}';
  const rows = importRows([source]);
  const bundle = rows.bundles.find((entry) => entry.id === "hello");
  const message = rows.messages.find((entry) => entry.bundleId === "hello");
  if (bundle === undefined || message === undefined) throw new Error("Missing message");
  bundle.id = "renamed";
  message.bundleId = "renamed";
  const [output] = await exportFiles({
    ...rows,
    files: [
      {
        path: "./lib/l10n/app_en.arb",
        locale: "en",
        content: new TextEncoder().encode(source),
        imported: true,
      },
    ],
  });
  expect(JSON.parse(new TextDecoder().decode(output?.content)) as unknown).toEqual({
    renamed: "Hi",
    next: "Bye",
  });
});

test("malformed previous file does not erase the current data", async () => {
  const rows = importRows([{ hello: "Hi" }]);
  const [output] = await exportFiles({
    ...rows,
    files: [
      {
        path: "./lib/l10n/app_en.arb",
        locale: "en",
        content: new TextEncoder().encode("invalid"),
        imported: true,
      },
    ],
  });
  expect(JSON.parse(new TextDecoder().decode(output?.content)) as unknown).toEqual({ hello: "Hi" });
});

test("new date/time and plural messages get compatible template types", async () => {
  const rows = importRows([
    {
      date: "{when, date, ::yMMMMd}",
      count: "{n, plural, one {One} other {Many}}",
    },
  ]);
  rows.bundles = rows.bundles.filter((bundle) => !bundle.id.startsWith("@inlang/arb/"));
  const [output] = await exportFiles(rows);
  const document = JSON.parse(new TextDecoder().decode(output?.content)) as Record<string, unknown>;
  expect(document["@date"]).toEqual({
    placeholders: { when: { type: "DateTime" } },
  });
  expect(document["@count"]).toEqual({ placeholders: { n: { type: "num" } } });
});
