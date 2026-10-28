# API usage

The package exports a default plugin and named `plugin`, `importFiles`, `exportFiles`, `exportWholeFiles`, `settingsSchema`, `ArbError`, `createMetadataBundle`, and `readMetadataBundle`. Public TypeScript types include `ArbSettings` and `ArbFileMetadata`.

## In-memory SDK integration

```ts
import { loadProjectInMemory, newProject } from "@inlang/sdk";
import arb from "inlang-plugin-arb";

const project = await loadProjectInMemory({
  blob: await newProject(),
  providePlugins: [arb],
});

try {
  await project.settings.set({
    baseLocale: "en",
    locales: ["en", "de"],
    modules: [],
    "plugin.inlang.arb": { useEscaping: true },
  });

  await project.importFiles({
    pluginKey: arb.key,
    files: [
      {
        locale: "en",
        content: new TextEncoder().encode(
          JSON.stringify({
            "@@locale": "en",
            hello: "Hello {name}!",
            "@hello": { placeholders: { name: { type: "String" } } },
          }),
        ),
      },
    ],
  });

  const files = await project.exportFiles({ pluginKey: arb.key });
  // Each file has locale, name, content, and a resolved metadata.pathPattern.
  const snapshot = await project.toBlob();
  // Store snapshot with your normal project storage.
} finally {
  await project.close();
}
```

Import all related locale files together, including when updating existing translations: bundle declarations are shared across locales and the plugin computes their union from the supplied catalogs. With relaxed syntax, Flutter also determines recognized placeholders from the base locale's template metadata. The import result uses `messageBundleId` and `messageLocale`; the SDK assigns concrete message and variant IDs. Call SDK import/export APIs to manage this mapping.

## Preserving existing file bytes

```ts
const files = await project.exportFiles({
  pluginKey: arb.key,
  files: [
    {
      path: "./lib/l10n/app_en.arb",
      locale: "en",
      content: existingBytes,
      imported: true,
    },
  ],
});
```

Set `imported: true` only when that content was imported or previously saved by the project. `saveProjectToDirectory` manages this automatically. The returned `verbatim: true` instructs the host to write bytes without reformatting.

## Editing descriptions and format metadata

```ts
import { createMetadataBundle, readMetadataBundle } from "inlang-plugin-arb";

const row = await project.db
  .selectFrom("inlang_bundle")
  .selectAll()
  .where("id", "=", "@inlang/arb/en")
  .executeTakeFirstOrThrow();

const data = readMetadataBundle({ id: row.id, declarations: row.declarations });
data.attributes["@hello"] = {
  description: "Shown on the welcome screen",
  placeholders: { name: { type: "String", example: "Ada" } },
};
const updated = createMetadataBundle(data);

await project.db
  .updateTable("inlang_bundle")
  .set({ declarations: updated.declarations })
  .where("id", "=", updated.id)
  .execute();
```

Reading returns an independent copy. `version: 1`, locale identity, and carrier structure are validated when exporting. Update the carrier for every affected locale when renaming resource IDs or placeholders.

When adding metadata for a newly created resource, add that resource ID to `data.keys` as well. Otherwise its attributes remain classified as an intentional orphan, which the plugin preserves after deletion. The optional `data.order` retains source key order; new resource/attribute pairs are appended when absent from that order.

## Errors

Direct plugin calls throw `ArbError` for invalid settings, resource syntax, metadata and unrepresentable exports. Diagnostics include the configured path, locale, resource ID and character offset where available; the original error is retained as `cause`. SDK hosts expose import/load errors through `await project.errors.get()`.
