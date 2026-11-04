import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  moduleUrl,
  readListing,
  registryManifestUrl,
  repositoryUrl,
  schemaUrl,
  validateBrowserBundle,
  validateListing,
  validateManifest,
  validatePackedFiles,
} from "../scripts/validate-marketplace.mjs";
import plugin from "../src/index.js";
import { pluginKey } from "../src/settings.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const listing = readListing(root);
const manifest = listing.manifest as Record<string, unknown>;
const pkg = listing.packageJson as Record<string, unknown> & { name: string; version: string };
const url = moduleUrl(pkg);
const packed = [
  "package.json",
  "dist/index.js",
  "marketplace-manifest.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "assets/icon.svg",
  "src/index.ts",
  "docs/api.md",
  "examples/flutter/l10n.yaml",
];

function changedManifest(field: string, value: unknown): Record<string, unknown> {
  return { ...manifest, [field]: value };
}

function expectListingError(changes: Partial<typeof listing>, message: string): void {
  expect(validateListing({ ...listing, ...changes }).join("\n")).toContain(message);
}

describe("committed marketplace and release files", () => {
  test("satisfy every local listing contract", () => {
    expect(validateManifest(manifest)).toEqual([]);
    expect(validateListing(listing)).toEqual([]);
    expect(manifest["$schema"]).toBe("https://inlang.com/schema/marketplace-manifest");
    expect(manifest["id"]).toBe(pluginKey);
    expect(manifest["id"]).toBe("plugin.inlang.arb");
    expect(manifest["id"]).toBe(plugin.key);
    expect(manifest["id"]).toMatch(/^plugin\.[^.]+\.[^.]+$/);
    expect(manifest["displayName"]).toEqual({ en: "Flutter ARB" });
    expect(manifest["description"]).toHaveProperty("en", expect.stringContaining("Flutter ARB"));
    expect(manifest["publisherName"]).toBe("sunderee");
    expect(manifest["license"]).toBe("MIT");
    expect(manifest["license"]).toBe(pkg["license"]);
    expect(listing.license.startsWith("MIT License\n")).toBe(true);
    expect(manifest["repository"]).toBe(repositoryUrl);
    expect(manifest["keywords"]).toEqual(
      expect.arrayContaining(["flutter", "dart", "arb", "localization", "plugin"]),
    );
    expect(manifest["module"]).toBe(url);
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.hostname).toBe("cdn.jsdelivr.net");
    expect(parsed.pathname).toBe(`/npm/${pkg.name}@${pkg.version}/dist/index.js`);
    expect(listing.readme).toContain(url);
    expect(listing.readme).toContain("SDK **4.0.4 or later**");
    expect(pkg["repository"]).toEqual({ type: "git", url: `git+${repositoryUrl}.git` });
    expect(pkg["bugs"]).toEqual({ url: `${repositoryUrl}/issues` });
    expect(pkg["homepage"]).toBe(`${repositoryUrl}#readme`);
    expect(pkg["files"]).toEqual(
      expect.arrayContaining(["dist", "marketplace-manifest.json", "assets", "CHANGELOG.md"]),
    );
    expect(pkg["exports"]).toHaveProperty(".", {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(listing.changelog).toContain("## 0.1.0");
    for (const content of [listing.readme, listing.changelog]) {
      expect(content).toContain(registryManifestUrl);
      expect(content).toMatch(/default branch[\s\S]{0,40}`master`/);
    }
    expect(listing.files["./README.md"]).toBe(listing.readme);
    expect(listing.files["./CHANGELOG.md"]).toBe(listing.changelog);
    expect(listing.files["./assets/icon.svg"]).toContain("<svg");
    expect(listing.files["./assets/icon.svg"]).not.toMatch(/flutter/i);
  });

  test("runs the real-files validator CLI", () => {
    expect(
      execFileSync(process.execPath, ["scripts/validate-marketplace.mjs"], {
        cwd: root,
        encoding: "utf8",
      }),
    ).toContain("contracts verified");
  });
});

describe("hostile manifest fixtures", () => {
  test.each([null, [], "manifest", 1])("rejects non-object %j", (value) => {
    expect(validateManifest(value)).toEqual(["manifest must be an object"]);
  });

  test.each([
    "$schema",
    "displayName",
    "description",
    "publisherName",
    "keywords",
    "id",
    "module",
    "license",
    "repository",
    "pages",
  ])("rejects missing %s", (field) => {
    const fixture = { ...manifest };
    delete fixture[field];
    expect(validateManifest(fixture).length).toBeGreaterThan(0);
  });

  test.each([
    ["$schema", "https://example.com/schema"],
    ["displayName", { en: " " }],
    ["displayName", "Flutter ARB"],
    ["description", { de: "ARB" }],
    ["description", { en: "ARB", de: 7 }],
    ["publisherName", "someone-else"],
    ["publisherLink", "http://github.com/sunderee"],
    ["license", "Apache-2.0"],
    ["repository", `${repositoryUrl}.git`],
    ["keywords", []],
    ["keywords", "flutter,dart,arb,localization,plugin"],
    ["keywords", ["flutter"]],
    ["keywords", ["flutter", "dart", "arb", "localization", "plugin", 1]],
    ["keywords", ["flutter", "dart", "arb", "localization", "plugin", " "]],
    ["pages", { "/": "./README.md" }],
    ["pages", []],
    ["icon", "../icon.svg"],
    ["icon", ".//icon.svg"],
    ["icon", "./assets/../icon.svg"],
    ["icon", "./assets\\icon.svg"],
    ["icon", "https://example.com/icon.svg"],
    ["icon", "./assets/%2e%2e/icon.svg"],
    ["icon", "./assets/icon.svg?x"],
    ["icon", `./assets/icon${String.fromCharCode(0)}.svg`],
    ["modul", url],
  ])("rejects invalid %s = %j", (field, value) => {
    expect(validateManifest(changedManifest(String(field), value)).length).toBeGreaterThan(0);
  });

  test.each([
    "app.inlang.arb",
    "library.inlang.arb",
    "guide.inlang.arb",
    "plugin.arb",
    "plugin..arb",
    "plugin.inlang.",
    "plugin.inlang.arb.extra",
    "plugin.in lang.arb",
  ])("rejects id %s", (id) => {
    expect(validateManifest(changedManifest("id", id)).join("\n")).toContain("id must match");
  });

  test.each([
    url.replace("https://", "http://"),
    "./dist/index.js",
    "https://raw.githubusercontent.com/sunderee/inlang-plugin-arb/master/dist/index.js",
    url.replace(`@${pkg.version}`, "@latest"),
    url.replace(`@${pkg.version}`, "@^0.1.0"),
    url.replace("index.js", "index.mjs"),
    url.replace("dist/index.js", "src/index.ts"),
    url.replace("/dist/", "/"),
    `${url}?version=1`,
    `${url}#fragment`,
    url.replace("cdn.jsdelivr.net", "cdn.jsdelivr.net.evil.test"),
  ])("rejects module %s", (module) => {
    expect(validateManifest(changedManifest("module", module)).join("\n")).toContain(
      "module must be",
    );
  });

  test("allows the optional icon and publisherLink to be absent", () => {
    const fixture = { ...manifest };
    delete fixture["icon"];
    delete fixture["publisherLink"];
    expect(validateManifest(fixture)).toEqual([]);
  });
});

describe("hostile cross-file fixtures", () => {
  test("rejects inconsistent plugin key and package identity", () => {
    expectListingError(
      { manifest: changedManifest("id", "plugin.inlang.other") },
      "id must equal pluginKey",
    );
    for (const module of [
      url.replace(pkg.name, "wrong-package"),
      url.replace(`@${pkg.version}`, "@9.9.9"),
    ]) {
      expectListingError(
        { manifest: changedManifest("module", module) },
        "module must match package name and exact version",
      );
    }
    expectListingError({ packageJson: null }, "package.json must be an object");
    expectListingError({ manifest: null }, "manifest must be an object");
    expectListingError(
      { packageJson: { ...pkg, version: "latest" } },
      "package name and exact version",
    );
    expectListingError({ packageJson: { ...pkg, name: "" } }, "package name and exact version");
  });

  test("rejects missing files and empty or malformed icons", () => {
    for (const reference of ["./README.md", "./CHANGELOG.md", "./assets/icon.svg"]) {
      const files = { ...listing.files };
      delete files[reference];
      expectListingError({ files }, `missing or empty listing file: ${reference}`);
    }
    expectListingError(
      { manifest: changedManifest("icon", "./missing.svg") },
      "missing or empty listing file: ./missing.svg",
    );
    expectListingError(
      {
        manifest: changedManifest("pages", {
          "/": "./README.md",
          "/changelog": "./CHANGELOG.md",
          "/extra": "./missing.md",
        }),
      },
      "missing or empty listing file: ./missing.md",
    );
    expectListingError(
      {
        manifest: changedManifest("pages", {
          "/": "./README.md",
          "/changelog": "./CHANGELOG.md",
          "/extra": "../outside.md",
        }),
      },
      "safe relative file paths",
    );
    for (const icon of [
      " ",
      "not svg",
      "<svg>",
      '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><title>Flutter</title></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>',
    ]) {
      expect(
        validateListing({ ...listing, files: { ...listing.files, "./assets/icon.svg": icon } })
          .length,
      ).toBeGreaterThan(0);
    }
  });

  test("rejects README URL loss even if the manifest is unchanged", () => {
    expectListingError(
      { readme: listing.readme.replaceAll(url, "https://example.com/wrong.js") },
      "README must contain the module URL",
    );
    expectListingError(
      { readme: listing.readme.replaceAll("```json", "```text") },
      "usable JSON modules installation example",
    );
    expectListingError(
      { readme: listing.readme.replace('"baseLocale": "en"', '"baseLocale": invalid') },
      "usable JSON modules installation example",
    );
    expectListingError(
      { readme: listing.readme.replace('"modules": [', '"disabledModules": [') },
      "usable JSON modules installation example",
    );
    expectListingError(
      { readme: listing.readme.replace("4.0.4 or later", "4.0.3 or later") },
      "SDK 4.0.4 or later",
    );
    expectListingError(
      {
        readme: listing.readme.replaceAll(
          registryManifestUrl,
          registryManifestUrl.replace("/master/", "/main/"),
        ),
      },
      "master default branch",
    );
    expectListingError(
      { changelog: listing.changelog.replace("## 0.1.0", "## Unreleased") },
      "CHANGELOG must mention",
    );
    expectListingError(
      { changelog: listing.changelog.replace("`master`", "`main`") },
      "master default branch",
    );
  });

  test.each(["repository", "files", "exports", "bugs", "homepage", "publishConfig", "author"])(
    "rejects missing package %s",
    (field) => {
      const fixture = { ...pkg };
      delete fixture[field];
      expect(validateListing({ ...listing, packageJson: fixture }).length).toBeGreaterThan(0);
    },
  );

  test("rejects license mismatch, private publication, bad exports and file exclusions", () => {
    expectListingError({ packageJson: { ...pkg, license: "Apache-2.0" } }, "license mismatch");
    expectListingError(
      { license: listing.license.replace("MIT License", "Apache License") },
      "license mismatch",
    );
    expectListingError({ packageJson: { ...pkg, private: true } }, "publish publicly");
    expectListingError(
      { packageJson: { ...pkg, exports: { ".": { import: "./src/index.ts" } } } },
      "exports[.].import",
    );
    expectListingError(
      { packageJson: { ...pkg, files: [...(pkg["files"] as string[]), "!dist/index.js"] } },
      "without exclusions",
    );
    expectListingError(
      {
        packageJson: {
          ...pkg,
          files: (pkg["files"] as string[]).filter((file) => file !== "dist"),
        },
      },
      "files must include dist",
    );
  });
});

describe("packed file contract", () => {
  test("accepts distributable sources and docs", () => {
    expect(validatePackedFiles(packed)).toEqual([]);
  });
  test.each([null, {}, "dist/index.js", [1]])("rejects invalid file list %j", (files) => {
    expect(validatePackedFiles(files)).toEqual(["packed files must be a string array"]);
  });
  test.each([
    "package.json",
    "dist/index.js",
    "marketplace-manifest.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "assets/icon.svg",
  ])("rejects missing packed %s", (file) => {
    expect(validatePackedFiles(packed.filter((entry) => entry !== file))).toEqual([
      `packed file missing: ${file}`,
    ]);
  });
  test.each([
    ".env",
    ".env.production",
    "src/.env",
    "src/secrets.json",
    "src/credentials.json",
    ".npmrc",
    "tests/marketplace.test.ts",
    "coverage/lcov.info",
    "node_modules/pkg/index.js",
    "docs/node_modules/evil.js",
    ".git/config",
    "src/private.key",
    "src/cert.pem",
    "../outside",
    "/absolute",
    "dist\\index.js",
    "old.tgz",
  ])("rejects forbidden packed %s", (file) => {
    expect(validatePackedFiles([...packed, file])).toEqual([`forbidden packed file: ${file}`]);
  });
});

function schemaClauses(value: unknown): Record<string, unknown>[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const node = value as Record<string, unknown>;
  const children = node["allOf"];
  return [node, ...(Array.isArray(children) ? children.flatMap(schemaClauses) : [])];
}

test("live schema still recognizes this plugin shape", async (context) => {
  let response: Response;
  try {
    response = await fetch(schemaUrl, { signal: AbortSignal.timeout(8000) });
  } catch {
    context.skip("Marketplace schema unavailable; all local contract tests still run");
    return;
  }
  expect(response.ok).toBe(true);
  const schema = (await response.json()) as { anyOf?: unknown[] };
  expect(Array.isArray(schema.anyOf)).toBe(true);
  const branch = schema.anyOf?.find((candidate) =>
    schemaClauses(candidate).some((clause) => {
      const properties = clause["properties"] as Record<string, { pattern?: string }> | undefined;
      return properties?.["id"]?.pattern?.startsWith("^plugin\\.");
    }),
  );
  expect(branch).toBeDefined();
  const clauses = schemaClauses(branch);
  const properties = Object.assign(
    {},
    ...clauses.map((clause) => clause["properties"] ?? {}),
  ) as Record<string, { const?: unknown; pattern?: string; type?: string }>;
  expect(properties["$schema"]?.const).toBe(manifest["$schema"]);
  const pattern = properties["id"]?.pattern;
  expect(pattern).toBeTypeOf("string");
  expect(String(manifest["id"])).toMatch(new RegExp(pattern ?? "(?!)"));
  expect(properties["module"]?.type).toBe("string");
  const required = clauses.flatMap((clause) =>
    Array.isArray(clause["required"]) ? clause["required"] : [],
  );
  expect(required).toEqual(
    expect.arrayContaining([
      "displayName",
      "description",
      "publisherName",
      "keywords",
      "module",
      "id",
    ]),
  );
  for (const field of required) expect(manifest).toHaveProperty(String(field));
});

describe("browser bundle contract", () => {
  test("accepts a self-contained ESM", () => {
    expect(validateBrowserBundle("export default { key: 'plugin.inlang.arb' };")).toEqual([]);
  });
  test.each([
    'import fs from "node:fs";',
    'export { readFile } from "node:fs/promises";',
    'import "node:crypto";',
    'const fs = require("fs");',
    "const fs = require('fs/promises');",
    'const p = import("node:path");',
    'const fs = __require("fs");',
    'import arb from "external-package";',
  ])("rejects external dependency %s", (source) => {
    expect(validateBrowserBundle(source)).toHaveLength(1);
    expect(validateBrowserBundle(source)[0]).toContain("external import in browser bundle");
  });
});
