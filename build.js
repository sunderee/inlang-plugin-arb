import { NodeModulesPolyfillPlugin } from "@esbuild-plugins/node-modules-polyfill";
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  minify: process.env.DEV ? false : true,
  watch: process.env.DEV ? true : false,
  format: "esm",
  platform: "browser",
  target: "es2020",
  plugins: [
    NodeModulesPolyfillPlugin(),
  ],
});

console.log("✅ build complete");
if (process.env.DEV) {
  console.log("👀 watching for changes...");
}
