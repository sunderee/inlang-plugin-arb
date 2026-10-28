import type { InlangPlugin, ProjectSettings } from "@inlang/sdk";
import { ArbError } from "./error.js";
import { isObject } from "./json.js";

export const pluginKey = "plugin.inlang.arb";

export interface ArbSettings {
  pathPattern?: string;
  localeFormat?: "underscore" | "bcp47";
  useEscaping?: boolean;
  useRelaxedSyntax?: boolean;
  syntax?: "flutter" | "icu";
  indentation?: number;
  maxVariants?: number;
}
export type Settings = ProjectSettings & { [pluginKey]?: ArbSettings };
export type ResolvedSettings = Required<ArbSettings>;

const defaults: ResolvedSettings = {
  pathPattern: "./lib/l10n/app_{locale}.arb",
  localeFormat: "underscore",
  useEscaping: false,
  useRelaxedSyntax: false,
  syntax: "flutter",
  indentation: 2,
  maxVariants: 4096,
};
const pathPattern = /^[^{}]*\{locale\}[^{}]*\.arb$/;
// inlang's public schema type uses TypeBox's standard Symbol.for tags. Keep
// those tags for hosts using TypeBox, without importing its schema builder.
const kind = Symbol.for("TypeBox.Kind");
const enumeration = (values: readonly string[], fallback: string) => ({
  [kind]: "Union",
  anyOf: values.map((value) => ({ [kind]: "Literal", type: "string", const: value })),
  default: fallback,
});
const properties = {
  pathPattern: {
    [kind]: "String",
    type: "string",
    pattern: pathPattern.source,
    default: defaults.pathPattern,
  },
  localeFormat: enumeration(["underscore", "bcp47"], defaults.localeFormat),
  useEscaping: { [kind]: "Boolean", type: "boolean", default: defaults.useEscaping },
  useRelaxedSyntax: { [kind]: "Boolean", type: "boolean", default: defaults.useRelaxedSyntax },
  syntax: enumeration(["flutter", "icu"], defaults.syntax),
  indentation: {
    [kind]: "Integer",
    type: "integer",
    minimum: 0,
    maximum: 8,
    default: defaults.indentation,
  },
  maxVariants: {
    [kind]: "Integer",
    type: "integer",
    minimum: 1,
    maximum: 100000,
    default: defaults.maxVariants,
  },
};
export const settingsSchema = {
  [kind]: "Object",
  type: "object",
  properties,
  additionalProperties: false,
  title: "Flutter ARB plugin settings",
} as unknown as NonNullable<InlangPlugin["settingsSchema"]>;

function validateSettings(config: unknown): asserts config is ArbSettings {
  const invalid = (field: string): never => {
    throw new ArbError(`Invalid settings at /${field}`, pluginKey);
  };
  if (!isObject(config)) return invalid("");
  for (const [field, value] of Object.entries(config)) {
    if (!Object.hasOwn(properties, field)) invalid(field);
    switch (field) {
      case "pathPattern":
        if (typeof value !== "string" || !pathPattern.test(value)) invalid(field);
        break;
      case "localeFormat":
        if (value !== "underscore" && value !== "bcp47") invalid(field);
        break;
      case "syntax":
        if (value !== "flutter" && value !== "icu") invalid(field);
        break;
      case "useEscaping":
      case "useRelaxedSyntax":
        if (typeof value !== "boolean") invalid(field);
        break;
      case "indentation":
      case "maxVariants": {
        const definition = properties[field];
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < definition.minimum ||
          value > definition.maximum
        )
          invalid(field);
        break;
      }
    }
  }
}

export function canonicalLocale(locale: string): string {
  if (!/^[a-zA-Z]{2,8}(?:[-_][a-zA-Z0-9]{1,8})*$/.test(locale)) {
    throw new ArbError(`Invalid locale ${JSON.stringify(locale)}`);
  }
  try {
    const result = Intl.getCanonicalLocales(locale.replace(/_/g, "-"))[0];
    if (result !== undefined) return result;
  } catch {
    // Give the same diagnostic for malformed and unsupported tags.
  }
  throw new ArbError(`Invalid locale ${JSON.stringify(locale)}`);
}

export function resolveSettings(settings: Settings): ResolvedSettings {
  const config: unknown = settings[pluginKey] === undefined ? {} : settings[pluginKey];
  validateSettings(config);
  const locales = settings.locales.map(canonicalLocale);
  if (new Set(locales).size !== locales.length)
    throw new ArbError("Project locales contain equivalent or duplicate locale tags");
  if (!locales.includes(canonicalLocale(settings.baseLocale)))
    throw new ArbError("baseLocale must be included in locales");
  const result: ResolvedSettings = { ...defaults, ...config };
  if (/\\|^\/|^[a-z]+:/i.test(result.pathPattern)) {
    throw new ArbError("pathPattern must be a relative POSIX path");
  }
  return result;
}

export function fileLocale(locale: string, config: ResolvedSettings): string {
  const canonical = canonicalLocale(locale);
  return config.localeFormat === "underscore" ? canonical.replace(/-/g, "_") : canonical;
}

export function filePath(locale: string, config: ResolvedSettings): string {
  return config.pathPattern.replace(/\{locale\}/, fileLocale(locale, config));
}
