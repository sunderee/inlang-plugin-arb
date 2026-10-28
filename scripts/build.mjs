import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  legalComments: "eof",
});
const { plugin } = await import("../dist/index.js");
await writeFile("dist/settings-schema.json", `${JSON.stringify(plugin.settingsSchema, null, 2)}\n`);
const notices = await Promise.all(
  [
    ["@inlang/sdk and @inlang/plugin-icu1 (Opral)", "node_modules/@inlang/sdk/LICENSE"],
    ["@sinclair/typebox", "node_modules/@sinclair/typebox/license"],
    ["@messageformat/parser", "node_modules/@messageformat/parser/LICENSE"],
    ["moo", "node_modules/moo/LICENSE"],
  ].map(async ([name, file]) => `${name}\n${await readFile(file, "utf8")}`),
);
await writeFile("dist/THIRD_PARTY_NOTICES.txt", notices.join("\n\n"));
