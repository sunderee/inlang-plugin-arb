import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadProjectFromDirectory,
  loadProjectInMemory,
  newProject,
  saveProjectToDirectory,
} from "@inlang/sdk";
import { expect, test } from "vitest";
import plugin from "../src/index.js";
import { file, settings } from "./helpers.js";

test("real SDK imports, edits, persists metadata through a closed snapshot and exports", async () => {
  const project = await loadProjectInMemory({
    blob: await newProject(),
    providePlugins: [plugin],
  });
  let snapshot: Blob;
  try {
    await project.settings.set(settings());
    await project.importFiles({
      pluginKey: plugin.key,
      files: [
        file("en", {
          "@@context": "home",
          hello: "Hello {name}",
          "@hello": {
            description: "greeting",
            placeholders: { name: { type: "String", example: "Ada" } },
          },
        }),
      ],
    });
    const variant = await project.db
      .selectFrom("inlang_variant")
      .selectAll()
      .executeTakeFirstOrThrow();
    await project.db
      .updateTable("inlang_variant")
      .set({
        pattern: [
          { type: "text", value: "Hi " },
          {
            type: "expression",
            arg: { type: "variable-reference", name: "name" },
          },
        ],
      })
      .where("id", "=", variant.id)
      .execute();
    snapshot = await project.toBlob();
  } finally {
    await project.close();
  }
  const reopened = await loadProjectInMemory({
    blob: snapshot,
    providePlugins: [plugin],
  });
  try {
    const [output] = await reopened.exportFiles({ pluginKey: plugin.key });
    expect(JSON.parse(new TextDecoder().decode(output?.content)) as unknown).toEqual({
      "@@context": "home",
      hello: "Hi {name}",
      "@hello": {
        description: "greeting",
        placeholders: { name: { type: "String", example: "Ada" } },
      },
    });
    expect(await reopened.errors.get()).toEqual([]);
  } finally {
    await reopened.close();
  }
});

test("SDK snapshots retain plural declarations and both numeric/category variants through an edit", async () => {
  const project = await loadProjectInMemory({ blob: await newProject(), providePlugins: [plugin] });
  let snapshot: Blob;
  try {
    await project.settings.set(settings());
    await project.importFiles({
      pluginKey: plugin.key,
      files: [
        file("en", { count: "{n, plural, one {One} other {Other}}" }),
        file("de", { count: "{n, plural, one {Eins} other {Andere}}" }),
      ],
    });
    const message = await project.db
      .selectFrom("inlang_message")
      .selectAll()
      .where("locale", "=", "en")
      .executeTakeFirstOrThrow();
    expect(message.selectors).toHaveLength(2);
    const variants = await project.db
      .selectFrom("inlang_variant")
      .selectAll()
      .where("message_id", "=", message.id)
      .execute();
    const paired = variants.filter((variant) =>
      variant.pattern.some((part) => part.type === "text" && part.value === "One"),
    );
    expect(paired).toHaveLength(2);
    for (const variant of paired)
      await project.db
        .updateTable("inlang_variant")
        .set({ pattern: [{ type: "text", value: "Updated" }] })
        .where("id", "=", variant.id)
        .execute();
    snapshot = await project.toBlob();
  } finally {
    await project.close();
  }
  const reopened = await loadProjectInMemory({ blob: snapshot, providePlugins: [plugin] });
  try {
    const outputs = await reopened.exportFiles({ pluginKey: plugin.key });
    expect(new TextDecoder().decode(outputs[0]?.content)).toContain("Updated");
    expect(new TextDecoder().decode(outputs[1]?.content)).toContain("Eins");
    expect(await reopened.errors.get()).toEqual([]);
  } finally {
    await reopened.close();
  }
});

test("SDK imports of related catalogs must remain a complete batch", async () => {
  const project = await loadProjectInMemory({ blob: await newProject(), providePlugins: [plugin] });
  const en = file("en", { count: "{n, plural, one {One} other {Other}}" });
  const de = file("de", { count: "{n, plural, one {Eins} other {Andere}}" });
  try {
    await project.settings.set(settings());
    await project.importFiles({ pluginKey: plugin.key, files: [en, de] });
    await project.importFiles({ pluginKey: plugin.key, files: [de] });
    await expect(project.exportFiles({ pluginKey: plugin.key })).rejects.toThrow(
      "Undeclared variable",
    );
    await project.importFiles({ pluginKey: plugin.key, files: [en, de] });
    expect(await project.exportFiles({ pluginKey: plugin.key })).toHaveLength(2);
  } finally {
    await project.close();
  }
});

test("directory load/save keeps byte-identical ARB, honors underscore paths and removes deleted resources", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inlang-arb-"));
  try {
    const projectPath = path.join(directory, "project.inlang");
    await mkdir(projectPath);
    await mkdir(path.join(directory, "lib/l10n"), { recursive: true });
    await writeFile(
      path.join(projectPath, "settings.json"),
      JSON.stringify(settings({}, ["en-US"])),
    );
    const source =
      '{\r\n\t"@@locale": "en_US",\r\n\t"hello": "\\u0048ello",\r\n\t"@hello": { "description": "Greeting" }\r\n}\r\n';
    const arbPath = path.join(directory, "lib/l10n/app_en_US.arb");
    await writeFile(arbPath, source);
    const project = await loadProjectFromDirectory({
      path: projectPath,
      fs,
      providePlugins: [plugin],
    });
    try {
      expect(await project.errors.get()).toEqual([]);
      expect(await project.db.selectFrom("inlang_message").selectAll().execute()).toHaveLength(1);
      await saveProjectToDirectory({ project, fs, path: projectPath });
      expect(await readFile(arbPath, "utf8")).toBe(source);
      await project.db.deleteFrom("inlang_variant").execute();
      await project.db.deleteFrom("inlang_message").execute();
      await saveProjectToDirectory({ project, fs, path: projectPath });
      expect(JSON.parse(await readFile(arbPath, "utf8")) as unknown).toEqual({
        "@@locale": "en_US",
      });
    } finally {
      await project.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
