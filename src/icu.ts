import { ArbError } from "./error.js";

export type IcuPart =
  | { type: "text"; value: string }
  | { type: "argument"; name: string }
  | { type: "formatter"; name: string; formatter: string; style?: string }
  | { type: "pound" }
  | {
      type: "choice";
      name: string;
      kind: "select" | "plural" | "selectordinal";
      offset: number;
      cases: Array<{ key: string; parts: IcuPart[] }>;
    };

const categories = /^(?:zero|one|two|few|many|other)$/;

/** Inspect ICU syntax before the inlang mapper expands it, using bounded recursion. */
export function parseIcu(source: string, maxVariants: number): IcuPart[] {
  let position = 0;
  const whitespace = /\s*/y;
  const word = /[^\p{Pattern_Syntax}\p{Pattern_White_Space}]+/uy;
  const exact = /=\d+/y;
  const pluralOffset = /offset\s*:\s*(\d+)/y;
  const fail = (reason: string): never => {
    throw new ArbError(`${reason} at offset ${position}`);
  };
  const match = (pattern: RegExp): RegExpExecArray | null => {
    pattern.lastIndex = position;
    const result = pattern.exec(source);
    if (result !== null) position = pattern.lastIndex;
    return result;
  };
  const space = (): void => {
    match(whitespace);
  };
  const expect = (character: string): void => {
    space();
    if (source[position] !== character) fail(`Expected ${JSON.stringify(character)}`);
    position++;
  };
  const identifier = (): string => {
    space();
    const result = match(word);
    if (result === null) return fail("Expected an ICU identifier");
    return result[0];
  };
  const bounded = (count: number): void => {
    if (count > maxVariants) fail(`Message expansion exceeds maxVariants (${maxVariants})`);
  };
  const quoted = (): string => {
    position++;
    let value = "";
    while (position < source.length) {
      const character = source[position++];
      if (character !== "'") {
        value += character ?? "";
        continue;
      }
      if (source[position] === "'") {
        value += "'";
        position++;
      } else return value;
    }
    return fail("Unmatched ICU apostrophe quote");
  };
  const style = (depth: number): string => {
    const start = position;
    let braces = 0;
    while (position < source.length) {
      const character = source[position];
      if (character === "'" && source[position + 1] === "'") {
        position += 2;
        continue;
      }
      if (character === "'" && /[{}#]/.test(source[position + 1] ?? "")) {
        quoted();
        continue;
      }
      if (character === "{") braces++;
      if (character === "}") {
        if (braces === 0) return source.slice(start, position).replace(/^\s+|\s+$/g, "");
        braces--;
      }
      if (depth + braces > 32) fail("Message nesting exceeds 32 levels");
      position++;
    }
    return fail("Unbalanced ICU opening brace");
  };
  const argument = (depth: number, inPlural: boolean): { part: IcuPart; variants: number } => {
    position++;
    const name = identifier();
    space();
    if (source[position] === "}") {
      position++;
      return { part: { type: "argument", name }, variants: 1 };
    }
    expect(",");
    const kind = identifier();
    space();
    if (kind !== "select" && kind !== "plural" && kind !== "selectordinal") {
      if (source[position] === "}") {
        position++;
        return { part: { type: "formatter", name, formatter: kind }, variants: 1 };
      }
      expect(",");
      const format = style(depth);
      expect("}");
      return { part: { type: "formatter", name, formatter: kind, style: format }, variants: 1 };
    }
    expect(",");
    space();
    const offsetMatch = match(pluralOffset);
    if (offsetMatch !== null && kind === "select") fail("A select cannot have a plural offset");
    const offset = offsetMatch === null ? 0 : Number(offsetMatch[1]);
    if (!Number.isFinite(offset)) fail("Plural offset must be finite");
    const cases: Array<{ key: string; parts: IcuPart[] }> = [];
    const keys = new Set<string>();
    let variants = 0;
    for (;;) {
      space();
      if (source[position] === "}") {
        position++;
        break;
      }
      const key = match(exact)?.[0] ?? identifier();
      if (kind === "select" && /^=/.test(key)) fail("A select cannot have an exact plural case");
      if (kind !== "select" && !/^=/.test(key) && !categories.test(key))
        fail(`Invalid plural category ${JSON.stringify(key)}`);
      if (keys.has(key)) fail("Duplicate select/plural case");
      keys.add(key);
      expect("{");
      const body = message(true, inPlural || kind !== "select", depth + 1);
      expect("}");
      cases.push({ key, parts: body.parts });
      variants += body.variants;
      bounded(variants);
    }
    if (!keys.has("other")) fail("A select/plural must contain an other case");
    return { part: { type: "choice", name, kind, offset, cases }, variants };
  };
  const message = (
    nested: boolean,
    inPlural: boolean,
    depth: number,
  ): { parts: IcuPart[]; variants: number } => {
    if (depth > 32) fail("Message nesting exceeds 32 levels");
    const parts: IcuPart[] = [];
    let text = "";
    let variants = 1;
    const flush = (): void => {
      if (text.length !== 0) {
        parts.push({ type: "text", value: text });
        text = "";
      }
    };
    while (position < source.length) {
      const character = source[position];
      if (character === "}") {
        if (nested) break;
        fail("Unbalanced ICU closing brace");
      }
      if (character === "'") {
        if (source[position + 1] === "'") {
          text += "'";
          position += 2;
          continue;
        }
        if (/[{}]/.test(source[position + 1] ?? "") || (inPlural && source[position + 1] === "#")) {
          text += quoted();
          continue;
        }
      }
      if (character === "{") {
        flush();
        const result = argument(depth, inPlural);
        parts.push(result.part);
        variants *= result.variants;
        bounded(variants);
      } else if (character === "#" && inPlural) {
        flush();
        parts.push({ type: "pound" });
        position++;
      } else {
        text += character ?? "";
        position++;
      }
    }
    if (nested && position === source.length) fail("Unbalanced ICU opening brace");
    flush();
    return { parts, variants };
  };
  return message(false, false, 0).parts;
}
