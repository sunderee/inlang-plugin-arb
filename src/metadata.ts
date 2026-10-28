import type { Bundle } from "@inlang/sdk";
import { ArbError } from "./error.js";
import { isObject, type JsonObject, object, parseArb } from "./json.js";

export const metadataPrefix = "@inlang/arb/";
export const metadataIdPattern = /^@inlang\/arb\//;
const declarationName = "__arb_file_metadata";

/** Persisted in a bundle with no messages; it never becomes an ARB resource. */
export interface ArbFileMetadata {
  version: 1;
  locale: string;
  keys: string[];
  attributes: JsonObject;
  order?: string[];
}

export function createMetadataBundle(metadata: ArbFileMetadata): Bundle {
  return {
    id: metadataPrefix + metadata.locale,
    declarations: [
      {
        type: "local-variable",
        name: declarationName,
        value: {
          type: "expression",
          arg: { type: "literal", value: JSON.stringify(metadata) },
        },
      },
    ],
  };
}

/** Read an independent copy. Use createMetadataBundle to persist an edited copy. */
export function readMetadataBundle(bundle: Bundle): ArbFileMetadata {
  const declaration = bundle.declarations[0];
  if (
    bundle.declarations.length !== 1 ||
    declaration?.type !== "local-variable" ||
    declaration.name !== declarationName ||
    declaration.value.arg.type !== "literal"
  ) {
    throw new ArbError("Invalid ARB metadata carrier", bundle.id);
  }
  // The carrier adds one container around the original ARB attributes.
  const data = parseArb(new TextEncoder().encode(declaration.value.arg.value), bundle.id, 65);
  const keys = data["keys"];
  const attributes = data["attributes"];
  const order = data["order"];
  if (
    data["version"] !== 1 ||
    typeof data["locale"] !== "string" ||
    bundle.id !== metadataPrefix + data["locale"] ||
    !Array.isArray(keys) ||
    !keys.every((key): key is string => typeof key === "string") ||
    !isObject(attributes) ||
    Object.keys(attributes).some((key) => !/^@/.test(key)) ||
    (order !== undefined &&
      (!Array.isArray(order) || !order.every((key): key is string => typeof key === "string")))
  ) {
    throw new ArbError("Invalid or unsupported ARB metadata carrier", bundle.id);
  }
  return {
    version: 1,
    locale: data["locale"],
    keys,
    attributes,
    ...(order === undefined ? {} : { order }),
  };
}

export function collectMetadata(document: JsonObject, locale: string): ArbFileMetadata {
  const attributes = object();
  for (const [key, value] of Object.entries(document)) if (/^@/.test(key)) attributes[key] = value;
  return {
    version: 1,
    locale,
    keys: Object.keys(document).filter((key) => !/^@/.test(key)),
    attributes,
    order: Object.keys(document),
  };
}

/** Validate known Flutter fields while retaining all extension attributes. */
export function validateAttributes(document: JsonObject, context: string): void {
  for (const [key, value] of Object.entries(document)) {
    if (!/^@(?!@)/.test(key)) continue;
    if (!isObject(value)) throw new ArbError(`${key} must be an attribute object`, context);
    for (const field of ["description", "context", "type"]) {
      if (value[field] !== undefined && typeof value[field] !== "string")
        throw new ArbError(`${key}.${field} must be a string`, context);
    }
    const placeholders = value["placeholders"];
    if (placeholders === undefined) continue;
    if (!isObject(placeholders))
      throw new ArbError(`${key}.placeholders must be an object`, context);
    for (const [name, placeholder] of Object.entries(placeholders)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
        throw new ArbError(`Invalid placeholder name ${JSON.stringify(name)}`, context);
      if (!isObject(placeholder))
        throw new ArbError(`${key}.placeholders.${name} must be an object`, context);
      for (const field of ["type", "format", "example"]) {
        if (placeholder[field] !== undefined && typeof placeholder[field] !== "string")
          throw new ArbError(`${key}.placeholders.${name}.${field} must be a string`, context);
      }
      if (
        placeholder["isCustomDateFormat"] !== undefined &&
        typeof placeholder["isCustomDateFormat"] !== "boolean"
      )
        throw new ArbError(
          `${key}.placeholders.${name}.isCustomDateFormat must be a boolean`,
          context,
        );
      if (
        placeholder["optionalParameters"] !== undefined &&
        !isObject(placeholder["optionalParameters"])
      )
        throw new ArbError(
          `${key}.placeholders.${name}.optionalParameters must be an object`,
          context,
        );
    }
  }
}

export function placeholderNames(document: JsonObject, key: string): Set<string> {
  const attributes = document[`@${key}`];
  const placeholders = isObject(attributes) ? attributes["placeholders"] : undefined;
  return new Set(isObject(placeholders) ? Object.keys(placeholders) : []);
}

export function isLiteralResource(
  document: JsonObject,
  template: JsonObject,
  key: string,
): boolean {
  const own = document[`@${key}`];
  const base = template[`@${key}`];
  const type =
    (isObject(own) ? own["type"] : undefined) ?? (isObject(base) ? base["type"] : undefined);
  return typeof type === "string" && type !== "text";
}

/** Keep imported order and place new resource attributes directly after their resource. */
export function orderDocument(
  document: JsonObject,
  metadata: ArbFileMetadata | undefined,
): JsonObject {
  const ordered = object();
  const add = (key: string): void => {
    if (Object.hasOwn(document, key) && !Object.hasOwn(ordered, key))
      ordered[key] = document[key] ?? null;
  };
  for (const key of metadata?.order ?? []) add(key);
  for (const key of Object.keys(document)) if (/^@@/.test(key)) add(key);
  for (const key of Object.keys(document)) {
    if (/^@/.test(key)) continue;
    add(key);
    add(`@${key}`);
  }
  for (const key of Object.keys(document)) add(key);
  return ordered;
}
