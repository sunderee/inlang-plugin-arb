import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { insertBundleNested, loadProjectInMemory, newProject } from "@inlang/sdk";
import plugin from "../dist/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "arb-flutter-conformance-"));
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: directory, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)),
    );
  });

const exportCatalogs = async (files, settings) => {
  const imported = plugin.importFiles({ files, settings });
  const messages = imported.messages.map((message, i) => ({
    ...message,
    id: `message-${i}`,
    selectors: message.selectors ?? [],
  }));
  const variants = imported.variants.map((variant, i) => {
    const message = messages.find(
      (entry) =>
        entry.bundleId === variant.messageBundleId && entry.locale === variant.messageLocale,
    );
    if (message === undefined) throw new Error("Missing imported message");
    return {
      id: `variant-${i}`,
      messageId: message.id,
      pattern: variant.pattern ?? [],
      matches: variant.matches ?? [],
    };
  });
  return plugin.exportFiles({
    bundles: imported.bundles,
    messages,
    variants,
    settings,
  });
};
try {
  const settings = {
    baseLocale: "en",
    locales: ["en", "de", "ar", "sl", "zh", "zh-Hant", "zh-Hant-TW"],
    modules: [],
    "plugin.inlang.arb": { useEscaping: true },
  };
  const files = await Promise.all(
    settings.locales.map(async (locale) => ({
      locale,
      content: new Uint8Array(
        ["en", "de"].includes(locale)
          ? await readFile(path.join(root, `examples/flutter/lib/l10n/app_${locale}.arb`))
          : new TextEncoder().encode(
              JSON.stringify({
                ...JSON.parse(
                  await readFile(path.join(root, "examples/flutter/lib/l10n/app_en.arb"), "utf8"),
                ),
                "@@locale": locale.replace(/-/g, "_"),
              }),
            ),
      ),
    })),
  );
  for (const file of files) {
    const document = JSON.parse(new TextDecoder().decode(file.content));
    document.pluralInputCollision = "{n, plural, one {One} other {Many}} {nPlural}";
    if (file.locale === settings.baseLocale)
      document["@pluralInputCollision"] = {
        placeholders: { n: { type: "num" }, nPlural: { type: "String" } },
      };
    file.content = new TextEncoder().encode(JSON.stringify(document));
  }
  const outputs = await exportCatalogs(files, settings);
  await mkdir(path.join(directory, "lib/l10n"), { recursive: true });
  await mkdir(path.join(directory, "test"));
  for (const output of outputs)
    await writeFile(path.join(directory, "lib/l10n", output.name), output.content);
  await writeFile(
    path.join(directory, "l10n.yaml"),
    await readFile(path.join(root, "examples/flutter/l10n.yaml")),
  );
  await writeFile(
    path.join(directory, "pubspec.yaml"),
    `name: arb_conformance\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\ndependencies:\n  flutter:\n    sdk: flutter\n  flutter_localizations:\n    sdk: flutter\n  intl: any\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\nflutter:\n  generate: true\n`,
  );
  await writeFile(
    path.join(directory, "test/conformance_test.dart"),
    `
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/intl.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:arb_conformance/l10n/generated/app_localizations_en.dart';
import 'package:arb_conformance/l10n/generated/app_localizations_de.dart';
import 'package:arb_conformance/l10n/generated/app_localizations_ar.dart';
import 'package:arb_conformance/l10n/generated/app_localizations_sl.dart';

Future<void> main() async {
  await initializeDateFormatting('en');
  final en = AppLocalizationsEn();
  final de = AppLocalizationsDe();
  test('interpolation and translations', () {
    expect(en.hello('Ada'), 'Hello Ada!');
    expect(de.hello('Ada'), 'Hallo Ada!');
  });
  test('exact and category plurals', () {
    expect(en.cart(0), 'Cart: Empty!');
    expect(en.cart(1), 'Cart: One item!');
    expect(en.cart(3), 'Cart: 3 things!');
  });
  test('plural locals cannot steal an input placeholder', () {
    expect(en.pluralInputCollision(2, 'Label'), 'Many Label');
    expect(en.pluralInputCollision(1, 'Label'), 'One Label');
  });
  test('nested selects and plurals', () {
    expect(en.nested('male', 1), 'He has one item');
    expect(en.nested('male', 3), 'He has 3 items');
    expect(en.nested('female', 1), 'They have one item');
    expect(en.nested('female', 3), 'They have 3 items');
  });
  test('Flutter literal hash behavior', () {
    expect(en.literalHash(1), '# item');
    expect(en.literalHash(3), '# items');
    expect(en.hashNested(3, 'x'), '# literal');
    expect(en.hashNested(3, 'unknown'), '# other');
    expect(en.hashNested(0, 'x'), 'Zero');
  });
  test('numeric short circuits and CLDR categories in several locales', () {
    final ar = AppLocalizationsAr();
    final sl = AppLocalizationsSl();
    expect(en.pluralCategories(0), 'Zero');
    expect(en.pluralCategories(1), 'One');
    expect(en.pluralCategories(2), 'Two');
    expect(en.pluralCategories(3), 'Other');
    expect(ar.pluralCategories(3), 'Few');
    expect(ar.pluralCategories(11), 'Many');
    expect(ar.pluralCategories(100), 'Other');
    expect(sl.pluralCategories(101), 'One');
    expect(sl.pluralCategories(102), 'Two');
    expect(sl.pluralCategories(103), 'Few');
  });
  test('Flutter apostrophe escaping', () {
    expect(en.escaped, "Hello! {Isn't} this a wonderful day?");
    expect(en.adjacentQuotes, "{'}");
  });
  test('number and custom date metadata', () {
    expect(en.money(1200), 'Total: ' + NumberFormat.compactCurrency(locale: 'en', decimalDigits: 2, name: 'USD', symbol: r'$').format(1200));
    final date = DateTime(2026, 10, 28);
    expect(en.date(date), 'Date: ' + DateFormat.yMMMd('en').format(date));
    expect(en.customDate(date), '2026-10-28');
    expect(en.inlineDate(date), DateFormat.yMMMMd('en').format(date));
  });
  test('numeric select cases remain strings', () {
    expect(en.selectNumeric('0'), 'Zero');
    expect(en.selectNumeric('1'), 'Other');
  });
}
`,
  );
  await run(process.env["FLUTTER_BIN"] ?? "flutter", ["pub", "get"]);
  await run(process.env["FLUTTER_BIN"] ?? "flutter", ["gen-l10n"]);
  await run(process.env["FLUTTER_BIN"] ?? "flutter", ["test", "--reporter", "expanded"]);

  // Exercise edits of real persisted SDK rows, including the existing-file export path.
  const project = await loadProjectInMemory({ blob: await newProject(), providePlugins: [plugin] });
  try {
    await project.settings.set(settings);
    await project.importFiles({ pluginKey: plugin.key, files });
    const hello = await project.db
      .selectFrom("inlang_message")
      .selectAll()
      .where("bundle_id", "=", "hello")
      .where("locale", "=", "en")
      .executeTakeFirstOrThrow();
    await project.db
      .updateTable("inlang_variant")
      .set({
        pattern: [
          { type: "text", value: "Welcome " },
          { type: "expression", arg: { type: "variable-reference", name: "name" } },
          { type: "text", value: "!" },
        ],
      })
      .where("message_id", "=", hello.id)
      .execute();
    const cart = await project.db
      .selectFrom("inlang_message")
      .selectAll()
      .where("bundle_id", "=", "cart")
      .where("locale", "=", "en")
      .executeTakeFirstOrThrow();
    const cartVariants = await project.db
      .selectFrom("inlang_variant")
      .selectAll()
      .where("message_id", "=", cart.id)
      .execute();
    let updated = 0;
    for (const variant of cartVariants) {
      if (!variant.pattern.some((part) => part.type === "text" && /One item/.test(part.value)))
        continue;
      await project.db
        .updateTable("inlang_variant")
        .set({
          pattern: variant.pattern.map((part) =>
            part.type === "text"
              ? { ...part, value: part.value.replace(/One item/, "Edited item") }
              : part,
          ),
        })
        .where("id", "=", variant.id)
        .execute();
      updated++;
    }
    assert.equal(updated, 2, "Both exact/category branches must be edited");

    const addMessage = async (id, declarations, selectors, variants) =>
      insertBundleNested(project.db, {
        id,
        declarations,
        messages: [
          {
            id: `${id}_en`,
            bundle_id: id,
            locale: "en",
            selectors,
            variants: variants.map((variant, index) => ({
              id: `${id}_${index}`,
              message_id: `${id}_en`,
              ...variant,
            })),
          },
        ],
      });
    await addMessage(
      "newDate",
      [{ type: "input-variable", name: "when" }],
      [],
      [
        {
          matches: [],
          pattern: [
            {
              type: "expression",
              arg: { type: "variable-reference", name: "when" },
              annotation: {
                type: "function-reference",
                name: "date",
                options: [{ name: "style", value: { type: "literal", value: "::yMMMMd" } }],
              },
            },
          ],
        },
      ],
    );
    await addMessage(
      "newCount",
      [
        { type: "input-variable", name: "n" },
        {
          type: "local-variable",
          name: "nExact",
          value: { type: "expression", arg: { type: "variable-reference", name: "n" } },
        },
        {
          type: "local-variable",
          name: "nCategory",
          value: {
            type: "expression",
            arg: { type: "variable-reference", name: "n" },
            annotation: { type: "function-reference", name: "plural", options: [] },
          },
        },
      ],
      [
        { type: "variable-reference", name: "nExact" },
        { type: "variable-reference", name: "nCategory" },
      ],
      [
        {
          matches: [
            { type: "literal-match", key: "nExact", value: "1" },
            { type: "catchall-match", key: "nCategory" },
          ],
          pattern: [{ type: "text", value: "One new" }],
        },
        {
          matches: [
            { type: "catchall-match", key: "nExact" },
            { type: "literal-match", key: "nCategory", value: "one" },
          ],
          pattern: [{ type: "text", value: "One new" }],
        },
        {
          matches: [
            { type: "catchall-match", key: "nExact" },
            { type: "catchall-match", key: "nCategory" },
          ],
          pattern: [
            { type: "expression", arg: { type: "variable-reference", name: "n" } },
            { type: "text", value: " new" },
          ],
        },
      ],
    );
    await addMessage(
      "$price",
      [],
      [],
      [{ matches: [], pattern: [{ type: "text", value: "Money" }] }],
    );

    const removed = await project.db
      .selectFrom("inlang_message")
      .selectAll()
      .where("bundle_id", "=", "selectNumeric")
      .execute();
    for (const message of removed) {
      await project.db.deleteFrom("inlang_variant").where("message_id", "=", message.id).execute();
      await project.db.deleteFrom("inlang_message").where("id", "=", message.id).execute();
    }
    await project.db.deleteFrom("inlang_bundle").where("id", "=", "selectNumeric").execute();
    const renamed = await project.db
      .selectFrom("inlang_bundle")
      .selectAll()
      .where("id", "=", "adjacentQuotes")
      .executeTakeFirstOrThrow();
    await project.db
      .insertInto("inlang_bundle")
      .values({ id: "renamedQuotes", declarations: renamed.declarations })
      .execute();
    await project.db
      .updateTable("inlang_message")
      .set({ bundle_id: "renamedQuotes" })
      .where("bundle_id", "=", "adjacentQuotes")
      .execute();
    await project.db.deleteFrom("inlang_bundle").where("id", "=", "adjacentQuotes").execute();

    const edited = await project.exportFiles({
      pluginKey: plugin.key,
      files: files.map((file) => ({
        ...file,
        path: `./lib/l10n/app_${file.locale.replace(/-/g, "_")}.arb`,
        imported: true,
      })),
    });
    assert.ok(edited.every((output) => output.verbatim));
    for (const output of edited) {
      const document = JSON.parse(new TextDecoder().decode(output.content));
      assert.equal(Object.hasOwn(document, "selectNumeric"), false);
      assert.equal(Object.hasOwn(document, "@selectNumeric"), false);
      assert.equal(Object.hasOwn(document, "adjacentQuotes"), false);
      await writeFile(path.join(directory, "lib/l10n", output.name), output.content);
    }
  } finally {
    await project.close();
  }

  const region = await plugin.exportFiles({
    settings: {
      baseLocale: "en-US",
      locales: ["en-US"],
      modules: [],
      "plugin.inlang.arb": { localeFormat: "bcp47", useEscaping: true },
    },
    bundles: [{ id: "hello", declarations: [{ type: "input-variable", name: "name" }] }],
    messages: [{ id: "us_hello", bundleId: "hello", locale: "en-US", selectors: [] }],
    variants: [
      {
        id: "us_variant",
        messageId: "us_hello",
        matches: [],
        pattern: [
          { type: "text", value: "Howdy " },
          { type: "expression", arg: { type: "variable-reference", name: "name" } },
          { type: "text", value: "!" },
        ],
      },
    ],
  });
  assert.equal(region[0]?.name, "app_en-US.arb");
  assert.equal(JSON.parse(new TextDecoder().decode(region[0]?.content))["@@locale"], "en_US");
  for (const output of region)
    await writeFile(path.join(directory, "lib/l10n", output.name), output.content);
  await writeFile(
    path.join(directory, "test/edited_test.dart"),
    `
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/intl.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:arb_conformance/l10n/generated/app_localizations.dart';
import 'package:arb_conformance/l10n/generated/app_localizations_en.dart';
import 'package:arb_conformance/l10n/generated/app_localizations_de.dart';
Future<void> main() async {
  await initializeDateFormatting('en');
  test('edited persisted SDK data and newly inferred placeholder types', () {
    final en = AppLocalizationsEn();
    expect(en.hello('Ada'), 'Welcome Ada!');
    expect(AppLocalizationsDe().hello('Ada'), 'Hallo Ada!');
    expect(en.cart(1), 'Cart: Edited item!');
    expect(en.cart(3), 'Cart: 3 things!');
    expect(en.newCount(1), 'One new');
    expect(en.newCount(3), '3 new');
    expect(en.newDate(DateTime(2026, 10, 28)), DateFormat.yMMMMd('en').format(DateTime(2026, 10, 28)));
    expect(en.renamedQuotes, "{'}");
    expect(en.$price, 'Money');
    expect(lookupAppLocalizations(const Locale('en', 'US')).hello('Ada'), 'Howdy Ada!');
  });
}
`,
  );
  await run(process.env["FLUTTER_BIN"] ?? "flutter", ["gen-l10n"]);
  await run(process.env["FLUTTER_BIN"] ?? "flutter", [
    "test",
    "test/edited_test.dart",
    "--reporter",
    "expanded",
  ]);
  const relaxedFiles = files.map((file) => {
    const document = JSON.parse(new TextDecoder().decode(file.content));
    document.relaxed = "It's {name}; {literal} }";
    if (file.locale === settings.baseLocale)
      document["@relaxed"] = { placeholders: { name: { type: "String" } } };
    return {
      locale: file.locale,
      content: new TextEncoder().encode(JSON.stringify(document)),
    };
  });
  const relaxedOutputs = await exportCatalogs(relaxedFiles, {
    ...settings,
    "plugin.inlang.arb": { useEscaping: false, useRelaxedSyntax: true },
  });
  for (const output of relaxedOutputs)
    await writeFile(path.join(directory, "lib/l10n", output.name), output.content);
  const yaml = await readFile(path.join(root, "examples/flutter/l10n.yaml"), "utf8");
  await writeFile(
    path.join(directory, "l10n.yaml"),
    `${yaml.replace("use-escaping: true", "use-escaping: false")}relax-syntax: true\n`,
  );
  await writeFile(
    path.join(directory, "test/relaxed_test.dart"),
    `
import 'package:flutter_test/flutter_test.dart';
import 'package:arb_conformance/l10n/generated/app_localizations_en.dart';
import 'package:arb_conformance/l10n/generated/app_localizations_de.dart';
void main() {
  test('relaxed syntax, template metadata and disabled escaping', () {
    expect(AppLocalizationsEn().relaxed('Ada'), "It's Ada; {literal} }");
    expect(AppLocalizationsDe().relaxed('Ada'), "It's Ada; {literal} }");
    expect(AppLocalizationsEn().escaped, "Hello! '{Isn''t}' this a wonderful day?");
  });
}
`,
  );
  await run(process.env["FLUTTER_BIN"] ?? "flutter", ["gen-l10n"]);
  await run(process.env["FLUTTER_BIN"] ?? "flutter", [
    "test",
    "test/relaxed_test.dart",
    "--reporter",
    "expanded",
  ]);
  console.log("Flutter gen-l10n and generated Dart behavior verified.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
