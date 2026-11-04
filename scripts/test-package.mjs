import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectFromDirectory, saveProjectToDirectory } from "@inlang/sdk";
import {
  moduleUrl,
  readListing,
  validateBrowserBundle,
  validateListing,
  validatePackedFiles,
} from "./validate-marketplace.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "arb-package-"));
try {
  // npm pack runs prepack, so this also rebuilds the workspace bundle and declarations.
  execFileSync("npm", ["pack", "--quiet", "--pack-destination", directory], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const archives = (await readdir(directory)).filter((file) => file.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const archive = path.join(directory, archives[0]);
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((file) => !file.endsWith("/"));
  assert.ok(entries.every((file) => file.startsWith("package/")));
  assert.deepEqual(validatePackedFiles(entries.map((file) => file.slice("package/".length))), []);
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
  const packedRoot = path.join(directory, "package");
  assert.deepEqual(validateListing(readListing(packedRoot)), []);
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

  await exerciseBundle(bundle, path.join(directory, "workspace"));
  const packedBundle = await readFile(path.join(packedRoot, "dist/index.js"), "utf8");
  assert.deepEqual(validateBrowserBundle(packedBundle), []);
  await exerciseBundle(packedBundle, path.join(directory, "packed"));
  const pkg = JSON.parse(await readFile(path.join(packedRoot, "package.json"), "utf8"));
  const publishedUrl = moduleUrl(pkg);
  let response;
  try {
    response = await fetch(publishedUrl, { signal: AbortSignal.timeout(8000) });
  } catch {
    console.log(`Skipping live module check: ${publishedUrl} is unreachable; local checks passed.`);
  }
  if (response?.status === 404) {
    console.log(`Skipping live module check: ${publishedUrl} returned 404 (not published yet).`);
  } else if (response) {
    assert.equal(response.status, 200, "Published module must return 200 or unpublished 404");
    await exerciseBundle(await response.text(), path.join(directory, "published"), publishedUrl);
    console.log(`Published URL loaded through the SDK: ${publishedUrl}`);
  }
  console.log(
    "Built and packed bundles passed SDK module loading, ARB import and byte-preserving save; packed listing assets verified.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function exerciseBundle(bundle, directory, remoteUrl = undefined) {
  assert.deepEqual(validateBrowserBundle(bundle), []);
  const projectPath = path.join(directory, "project.inlang");
  await mkdir(projectPath, { recursive: true });
  await mkdir(path.join(directory, "plugins"));
  await mkdir(path.join(directory, "lib/l10n"), { recursive: true });
  await writeFile(path.join(directory, "plugins/arb.js"), bundle);
  await writeFile(
    path.join(projectPath, "settings.json"),
    JSON.stringify({
      baseLocale: "en",
      locales: ["en"],
      modules: [remoteUrl ?? "./plugins/arb.js"],
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
}
