// @ts-check
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const schemaUrl = "https://inlang.com/schema/marketplace-manifest";
export const repositoryUrl = "https://github.com/sunderee/inlang-plugin-arb";
export const registryManifestUrl =
  "https://raw.githubusercontent.com/sunderee/inlang-plugin-arb/refs/heads/master/marketplace-manifest.json";
const keywords = ["flutter", "dart", "arb", "localization", "plugin"];
const manifestFields = new Set([
  "$schema",
  "id",
  "displayName",
  "description",
  "publisherName",
  "publisherLink",
  "license",
  "repository",
  "pages",
  "keywords",
  "module",
  "icon",
]);
const packageFiles = [
  "dist",
  "src",
  "README.md",
  "LICENSE",
  "docs",
  "examples",
  "marketplace-manifest.json",
  "assets",
  "CHANGELOG.md",
];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** @param {unknown} value @returns {value is string} */
function localPath(value) {
  return (
    typeof value === "string" &&
    /^\.\/(?!\/)/.test(value) &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === ".." || part === "") &&
    !/[?#%]/.test(value) &&
    !value.includes(String.fromCharCode(0))
  );
}

/** @param {{name: string, version: string}} pkg */
export function moduleUrl(pkg) {
  return `https://cdn.jsdelivr.net/npm/${pkg.name}@${pkg.version}/dist/index.js`;
}

/** @param {{name: string}} pkg */
export function latestModuleUrl(pkg) {
  return `https://cdn.jsdelivr.net/npm/${pkg.name}@latest/dist/index.js`;
}

/** Focused repository contract, deliberately stricter than the marketplace schema.
 * @param {unknown} manifest @returns {string[]}
 */
export function validateManifest(manifest) {
  if (!isObject(manifest)) return ["manifest must be an object"];
  const errors = [];
  if (manifest["$schema"] !== schemaUrl) errors.push("$schema must equal the official schema URL");
  if (typeof manifest["id"] !== "string" || !/^plugin\.[^.\s]+\.[^.\s]+$/.test(manifest["id"])) {
    errors.push("id must match plugin.<namespace>.<name>");
  }
  for (const field of ["displayName", "description"]) {
    const value = manifest[field];
    if (!isObject(value) || !nonempty(value["en"]) || !Object.values(value).every(nonempty)) {
      errors.push(`${field} must contain non-empty localized strings including en`);
    }
  }
  if (manifest["publisherName"] !== "sunderee") errors.push("publisherName must be sunderee");
  if (manifest["license"] !== "MIT") errors.push("license must be MIT");
  if (manifest["repository"] !== repositoryUrl)
    errors.push("repository must be the GitHub HTTPS URL");
  if (
    manifest["publisherLink"] !== undefined &&
    manifest["publisherLink"] !== "https://github.com/sunderee"
  ) {
    errors.push("publisherLink must be the publisher's GitHub URL");
  }
  const tags = manifest["keywords"];
  if (
    !Array.isArray(tags) ||
    !tags.every(nonempty) ||
    !keywords.every((tag) => tags.includes(tag))
  ) {
    errors.push(
      "keywords must be a string array including flutter, dart, arb, localization, plugin",
    );
  }
  if (
    typeof manifest["module"] !== "string" ||
    !/^https:\/\/cdn\.jsdelivr\.net\/npm\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@latest\/dist\/index\.js$/.test(
      manifest["module"],
    )
  ) {
    errors.push("module must be a jsDelivr npm @latest dist/index.js URL");
  }
  const pages = manifest["pages"];
  if (
    !isObject(pages) ||
    pages["/"] !== "./README.md" ||
    pages["/changelog"] !== "./CHANGELOG.md"
  ) {
    errors.push("pages must map / to ./README.md and /changelog to ./CHANGELOG.md");
  }
  if (isObject(pages) && !Object.values(pages).every(localPath)) {
    errors.push("pages must use safe relative file paths");
  }
  if (manifest["icon"] !== undefined && !localPath(manifest["icon"])) {
    errors.push("icon must use a safe relative file path");
  }
  for (const field of Object.keys(manifest)) {
    if (!manifestFields.has(field)) errors.push(`unknown manifest field: ${field}`);
  }
  return errors;
}

/** @param {string} svg */
function validSvg(svg) {
  if (
    !/^\s*<svg\b[^>]*\bxmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>/.test(svg) ||
    !/<\/svg>\s*$/.test(svg) ||
    /flutter|<!|<script\b|\bon\w+=/i.test(svg)
  )
    return false;
  const stack = [];
  for (const tag of svg.matchAll(/<\s*(\/?)([\w:-]+)\b[^>]*>/g)) {
    if (tag[1] === "/") {
      if (stack.pop() !== tag[2]) return false;
    } else if (!tag[0].endsWith("/>")) stack.push(tag[2]);
  }
  return stack.length === 0;
}

/** @typedef {{manifest: unknown, packageJson: unknown, pluginKey: string, readme: string,
 * license: string, changelog: string, files: Record<string, string>}} Listing */

/** Validate supplied disk contents without doing IO.
 * @param {Listing} listing @returns {string[]}
 */
export function validateListing(listing) {
  const { manifest, packageJson: pkg, pluginKey, readme, license, changelog, files } = listing;
  const errors = validateManifest(manifest);
  if (!isObject(manifest)) return errors;
  if (!isObject(pkg)) return [...errors, "package.json must be an object"];
  if (manifest["id"] !== pluginKey) errors.push("id must equal pluginKey");
  const name = pkg["name"];
  const version = pkg["version"];
  if (
    !nonempty(name) ||
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(version)
  ) {
    errors.push("package name and exact version are required");
  } else {
    const url = latestModuleUrl({ name });
    if (manifest["module"] !== url) errors.push("module must match package name and @latest");
    if (!readme.includes(url)) errors.push("README must contain the module URL");
    const settingsExamples = [...readme.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
    const hasInstallExample = settingsExamples.some((match) => {
      try {
        const settings = JSON.parse(match[1] ?? "");
        return (
          isObject(settings) &&
          Array.isArray(settings["modules"]) &&
          settings["modules"].includes(url) &&
          settings["baseLocale"] === "en" &&
          Array.isArray(settings["locales"]) &&
          isObject(settings[pluginKey])
        );
      } catch {
        return false;
      }
    });
    if (!hasInstallExample)
      errors.push("README must have a usable JSON modules installation example");
    if (!changelog.includes(`## ${version}`))
      errors.push("CHANGELOG must mention the package version");
  }
  if (!/SDK\s+\*\*4\.0\.4 or later\*\*/.test(readme))
    errors.push("README must state SDK 4.0.4 or later");
  for (const [label, content] of Object.entries({ README: readme, CHANGELOG: changelog })) {
    if (
      !content.includes(registryManifestUrl) ||
      !/default branch[\s\S]{0,40}`master`/.test(content)
    ) {
      errors.push(`${label} must document the master default branch and registry manifest URL`);
    }
  }
  if (pkg["license"] !== manifest["license"] || !/^MIT License\r?\n/.test(license))
    errors.push("license mismatch between manifest, package.json and LICENSE");
  if (pkg["author"] !== "Peter Aleksander Bizjak" || !license.includes("Peter Aleksander Bizjak"))
    errors.push("author must match the LICENSE copyright holder");
  const repo = pkg["repository"];
  if (!isObject(repo) || repo["type"] !== "git" || repo["url"] !== `git+${repositoryUrl}.git`)
    errors.push("package repository is required");
  const bugs = pkg["bugs"];
  if (!isObject(bugs) || bugs["url"] !== `${repositoryUrl}/issues`)
    errors.push("package bugs.url is required");
  if (pkg["homepage"] !== `${repositoryUrl}#readme`)
    errors.push("package homepage must link to the README");
  const publish = pkg["publishConfig"];
  if (
    pkg["private"] === true ||
    !isObject(publish) ||
    publish["access"] !== "public" ||
    publish["provenance"] !== true
  )
    errors.push("package must publish publicly with provenance");
  const exports = pkg["exports"];
  const entry = isObject(exports) ? exports["."] : undefined;
  if (!isObject(entry) || entry["import"] !== "./dist/index.js")
    errors.push("package exports[.].import must be ./dist/index.js");
  const included = pkg["files"];
  if (
    !Array.isArray(included) ||
    !included.every(nonempty) ||
    !packageFiles.every((file) => included.includes(file)) ||
    included.some((file) => file.startsWith("!"))
  ) {
    errors.push(
      "package files must include dist, sources, docs and all listing assets without exclusions",
    );
  }
  const pages = manifest["pages"];
  const references = [...(isObject(pages) ? Object.values(pages) : []), manifest["icon"]];
  for (const reference of references) {
    if (!localPath(reference)) continue;
    const content = files[reference];
    if (!nonempty(content)) errors.push(`missing or empty listing file: ${reference}`);
    else if (reference.endsWith(".svg") && !validSvg(content))
      errors.push(`invalid SVG icon: ${reference}`);
  }
  return errors;
}

/** @param {unknown} files @returns {string[]} */
export function validatePackedFiles(files) {
  if (!Array.isArray(files) || !files.every(nonempty))
    return ["packed files must be a string array"];
  const errors = [];
  const required = [
    "package.json",
    "dist/index.js",
    "marketplace-manifest.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "assets/icon.svg",
  ];
  for (const file of required)
    if (!files.includes(file)) errors.push(`packed file missing: ${file}`);
  for (const file of files) {
    if (
      file.startsWith("/") ||
      file.includes("\\") ||
      file.split("/").includes("..") ||
      /(^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.git|node_modules|tests?|coverage|secrets?(?:\.[^/]*)?|credentials(?:\.[^/]*)?)(\/|$)/i.test(
        file,
      ) ||
      /\.(?:pem|key|tgz)$/i.test(file)
    )
      errors.push(`forbidden packed file: ${file}`);
  }
  return errors;
}

/** The published module must be self-contained in browser hosts.
 * @param {string} bundle @returns {string[]}
 */
export function validateBrowserBundle(bundle) {
  const imports = [
    ...bundle.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|(?:__)?require\s*\(\s*)["']([^"']+)["']/g),
  ];
  return imports.map((match) => `external import in browser bundle: ${match[1]}`);
}

/** @param {string} root @returns {Listing} */
export function readListing(root) {
  const read = (/** @type {string} */ file) => readFileSync(path.join(root, file), "utf8");
  const manifest = JSON.parse(read("marketplace-manifest.json"));
  /** @type {Record<string, string>} */
  const files = {};
  const pages = isObject(manifest["pages"]) ? Object.values(manifest["pages"]) : [];
  for (const reference of [...pages, manifest["icon"]]) {
    if (!localPath(reference)) continue;
    try {
      if (statSync(path.join(root, reference)).isFile()) files[reference] = read(reference);
    } catch {
      /* Missing files are reported by validateListing. */
    }
  }
  return {
    manifest,
    packageJson: JSON.parse(read("package.json")),
    pluginKey: /export const pluginKey = "([^"]+)"/.exec(read("src/settings.ts"))?.[1] ?? "",
    readme: read("README.md"),
    license: read("LICENSE"),
    changelog: read("CHANGELOG.md"),
    files,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const errors = validateListing(readListing(fileURLToPath(new URL("../", import.meta.url))));
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Marketplace manifest, documentation and package contracts verified.");
}
