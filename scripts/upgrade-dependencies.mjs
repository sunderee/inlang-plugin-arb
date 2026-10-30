import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packagePath = path.join(process.cwd(), "package.json");
const typeboxOverride = "@sinclair/typebox";

export function listedPackages(manifest) {
  return {
    dependencies: Object.keys(manifest.dependencies ?? {}),
    devDependencies: Object.keys(manifest.devDependencies ?? {}),
  };
}

export function latestInstallSpec(names) {
  return names.map((name) => `${name}@latest`);
}

export function withLatestTypeboxOverride(manifest, version) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("TypeBox override version must be a non-empty string");
  }
  return {
    ...manifest,
    overrides: { ...manifest.overrides, [typeboxOverride]: version },
  };
}

export function planUpgrade(manifest, latestTypebox) {
  const { dependencies, devDependencies } = listedPackages(manifest);
  return {
    commands: [
      ...(dependencies.length === 0
        ? []
        : [{ save: "--save", packages: latestInstallSpec(dependencies) }]),
      ...(devDependencies.length === 0
        ? []
        : [{ save: "--save-dev", packages: latestInstallSpec(devDependencies) }]),
    ],
    nextManifest: withLatestTypeboxOverride(manifest, latestTypebox),
  };
}

function runNpm(args, dryRun) {
  if (dryRun) {
    console.log(["npm", ...args].join(" "));
    return;
  }
  execFileSync("npm", args, { stdio: "inherit" });
}

function latestPublished(name) {
  return execFileSync("npm", ["view", name, "version"], { encoding: "utf8" }).trim();
}

export function main(argv = process.argv.slice(2), io = { readFileSync: fs.readFileSync }) {
  const dryRun = argv.includes("--dry-run");
  const manifest = JSON.parse(io.readFileSync(packagePath, "utf8"));
  const before = listedPackages(manifest);
  if (before.dependencies.length === 0 && before.devDependencies.length === 0) {
    throw new Error("package.json has no dependencies to upgrade");
  }
  const latestTypebox = dryRun
    ? (manifest.overrides?.[typeboxOverride] ?? "0.0.0")
    : latestPublished(typeboxOverride);
  const { commands, nextManifest } = planUpgrade(manifest, latestTypebox);
  for (const command of commands) runNpm(["install", command.save, ...command.packages], dryRun);
  if (!dryRun) {
    const upgraded = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    fs.writeFileSync(
      packagePath,
      `${JSON.stringify(withLatestTypeboxOverride(upgraded, latestTypebox), null, 2)}\n`,
    );
    runNpm(["install"], false);
  }
  return { dryRun, nextManifest };
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) main();
