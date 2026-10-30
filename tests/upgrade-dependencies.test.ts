import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  latestInstallSpec,
  listedPackages,
  main,
  planUpgrade,
  withLatestTypeboxOverride,
} from "../scripts/upgrade-dependencies.mjs";

const fixture = {
  name: "fixture",
  dependencies: { "@inlang/sdk": "^4.0.4", "@inlang/plugin-icu1": "1.3.4" },
  devDependencies: { typescript: "^6.0.3", vitest: "^5.0.5" },
  overrides: { "@sinclair/typebox": "0.34.41" },
};

describe("dependency upgrade planner", () => {
  test("lists every declared production and development package", () => {
    expect(listedPackages(fixture)).toEqual({
      dependencies: ["@inlang/sdk", "@inlang/plugin-icu1"],
      devDependencies: ["typescript", "vitest"],
    });
    expect(listedPackages({})).toEqual({ dependencies: [], devDependencies: [] });
  });

  test("always requests the published latest of each existing name", () => {
    expect(latestInstallSpec(["@inlang/sdk", "typescript"])).toEqual([
      "@inlang/sdk@latest",
      "typescript@latest",
    ]);
  });

  test("keeps unrelated manifest fields and refreshes only the TypeBox override", () => {
    const next = withLatestTypeboxOverride(
      { ...fixture, scripts: { check: "true" }, overrides: { leftover: "1.0.0" } },
      "0.34.52",
    );
    expect(next.scripts).toEqual({ check: "true" });
    expect(next.dependencies).toEqual(fixture.dependencies);
    expect(next.devDependencies).toEqual(fixture.devDependencies);
    expect(next.overrides).toEqual({ leftover: "1.0.0", "@sinclair/typebox": "0.34.52" });
    expect(() => withLatestTypeboxOverride(fixture, "")).toThrow("non-empty");
  });

  test("never empties dependency maps before installing latest", () => {
    const plan = planUpgrade(fixture, "0.34.52");
    expect(plan.commands).toEqual([
      { save: "--save", packages: ["@inlang/sdk@latest", "@inlang/plugin-icu1@latest"] },
      { save: "--save-dev", packages: ["typescript@latest", "vitest@latest"] },
    ]);
    expect(Object.keys(plan.nextManifest.dependencies ?? {})).toEqual([
      "@inlang/sdk",
      "@inlang/plugin-icu1",
    ]);
    expect(Object.keys(plan.nextManifest.devDependencies ?? {})).toEqual(["typescript", "vitest"]);
    expect(plan.nextManifest.overrides).toEqual({ "@sinclair/typebox": "0.34.52" });
    expect(JSON.stringify(plan)).not.toContain('"dependencies":{}');
    expect(JSON.stringify(plan)).not.toContain('"devDependencies":{}');
  });
});

describe("upgrade script entry", () => {
  test("dry-run plans from package.json without rewriting it", () => {
    const before = readFileSync("package.json", "utf8");
    const current = JSON.parse(before) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    };
    const names = listedPackages(current);
    expect(names.dependencies.length).toBeGreaterThan(0);
    expect(names.devDependencies.length).toBeGreaterThan(0);
    const result = main(["--dry-run"]);
    expect(result.dryRun).toBe(true);
    expect(listedPackages(result.nextManifest)).toEqual(names);
    expect(result.nextManifest.overrides?.["@sinclair/typebox"]).toBe(
      current.overrides?.["@sinclair/typebox"],
    );
    expect(readFileSync("package.json", "utf8")).toBe(before);
    const output = execFileSync(
      process.execPath,
      ["scripts/upgrade-dependencies.mjs", "--dry-run"],
      {
        encoding: "utf8",
      },
    );
    for (const name of [...names.dependencies, ...names.devDependencies]) {
      expect(output).toContain(`${name}@latest`);
    }
    expect(output).not.toContain("dependencies = {}");
  });
});
