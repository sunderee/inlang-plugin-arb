import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProjectFromDirectory, saveProjectToDirectory } from "@inlang/sdk";

const bundle = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
const module = await import(
  `data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`
);
assert.equal(module.default.key, "plugin.inlang.arb");
// Exercise the schema with the validator declared by the SDK, not a new dependency.
const sdkRequire = createRequire(import.meta.resolve("@inlang/sdk"));
const { Value } = sdkRequire("@sinclair/typebox/value");
const { TypeCompiler } = sdkRequire("@sinclair/typebox/compiler");
const compiledSchema = TypeCompiler.Compile(module.settingsSchema);
for (const config of [
  {},
  { syntax: "icu", maxVariants: 2 },
  { useEscaping: true, indentation: 0 },
]) {
  assert.equal(Value.Check(module.settingsSchema, config), true);
  assert.equal(compiledSchema.Check(config), true);
}
for (const config of [
  null,
  [],
  { unknown: true },
  { syntax: "bad" },
  { maxVariants: 0 },
  { useEscaping: "true" },
]) {
  assert.equal(Value.Check(module.settingsSchema, config), false);
  assert.equal(compiledSchema.Check(config), false);
}

const directory = await mkdtemp(path.join(tmpdir(), "arb-package-"));
try {
  const projectPath = path.join(directory, "project.inlang");
  await mkdir(projectPath);
  await mkdir(path.join(directory, "plugins"));
  await mkdir(path.join(directory, "lib/l10n"), { recursive: true });
  await writeFile(path.join(directory, "plugins/arb.js"), bundle);
  await writeFile(
    path.join(projectPath, "settings.json"),
    JSON.stringify({
      baseLocale: "en",
      locales: ["en"],
      modules: ["./plugins/arb.js"],
    }),
  );
  const source =
    '{\n  "@@locale": "en",\n  "hello": "Hello {name}",\n  "@hello": {"placeholders":{"name":{"type":"String"}}}\n}\n';
  const resource = path.join(directory, "lib/l10n/app_en.arb");
  await writeFile(resource, source);
  const project = await loadProjectFromDirectory({ path: projectPath, fs });
  try {
    assert.deepEqual(await project.errors.get(), []);
    assert.equal((await project.plugins.get())[0]?.key, "plugin.inlang.arb");
    assert.equal((await project.db.selectFrom("inlang_message").selectAll().execute()).length, 1);
    await saveProjectToDirectory({ project, fs, path: projectPath });
    assert.equal(await readFile(resource, "utf8"), source);
  } finally {
    await project.close();
  }
  console.log(
    "Self-contained bundle, SDK module loading, import and byte-preserving directory save verified.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
