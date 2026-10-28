import { ArbError, errorMessage } from "./error.js";

export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Native JSON parsing plus an iterative scan for duplicate keys and bounded nesting. */
export function parseArb(content: Uint8Array, context: string, maxDepth = 64): JsonObject {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (cause) {
    throw new ArbError("File is not valid UTF-8", context, { cause });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new ArbError(`Invalid JSON: ${errorMessage(cause)}`, context, { cause });
  }
  if (!isObject(value)) throw new ArbError("ARB must be a JSON object", context);

  // Syntax is already validated, so the token alternatives cannot overlap.
  const token =
    /[ \t\r\n]+|"(?:\\[\s\S]|[^"\\])*"|[{}[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gy;
  const stack: Array<{ keys: Set<string>; expectingKey: boolean } | null> = [];
  for (const match of text.matchAll(token)) {
    const part = match[0];
    const parent = stack.at(-1);
    if (part === "{" || part === "[") {
      if (stack.length >= maxDepth)
        throw new ArbError(`JSON nesting exceeds ${maxDepth} levels`, context);
      stack.push(part === "{" ? { keys: new Set(), expectingKey: true } : null);
    } else if (part === "}" || part === "]") {
      stack.pop();
    } else if (part === ":" && parent != null) {
      parent.expectingKey = false;
    } else if (part === "," && parent != null) {
      parent.expectingKey = true;
    } else if (/^"/.test(part) && parent?.expectingKey) {
      const key = JSON.parse(part) as string;
      if (parent.keys.has(key))
        throw new ArbError(
          `Duplicate JSON key ${JSON.stringify(key)} at offset ${match.index}`,
          context,
        );
      parent.keys.add(key);
    } else if (/^-?\d/.test(part) && !Number.isFinite(Number(part))) {
      throw new ArbError("JSON number must be finite", context);
    }
  }
  return value;
}

export function object(): JsonObject {
  return Object.create(null) as JsonObject;
}
