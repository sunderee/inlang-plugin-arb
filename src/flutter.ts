import { escapeIcuText } from "@inlang/plugin-icu1";
import { ArbError } from "./error.js";
import { type IcuPart, parseIcu } from "./icu.js";
import type { ResolvedSettings } from "./settings.js";

type ConvertedMessage = { source: string; variants: number };

const categories = new Set(["zero", "one", "two", "few", "many", "other"]);
const pluralAliases: Readonly<Record<string, string | undefined>> = {
  "=0": "zero",
  "=1": "one",
  "=2": "two",
};

/** Convert Flutter's lexer rules to ICU1, without changing the displayed text. */
export function flutterToIcu(
  source: string,
  config: ResolvedSettings,
  placeholders: ReadonlySet<string>,
): string {
  let position = 0;
  const identifier = /[a-zA-Z_][a-zA-Z0-9_]*/y;
  const whitespacePattern = /\s*/y;
  const nextIdentifier = /\{\s*([a-zA-Z_][a-zA-Z0-9_]*)/y;
  const number = /\d+/y;
  const caseKey = /[a-zA-Z0-9_]+/y;
  const skeletonPrefix = /::/y;
  const offsetPrefix = /offset\s*:/y;
  const match = (pattern: RegExp, consume = true): RegExpExecArray | null => {
    pattern.lastIndex = position;
    const result = pattern.exec(source);
    if (consume && result !== null) position = pattern.lastIndex;
    return result;
  };
  const fail = (message: string): never => {
    throw new ArbError(`${message} at offset ${position}`);
  };
  const bounded = (count: number): void => {
    if (count > config.maxVariants)
      fail(`Message expansion exceeds maxVariants (${config.maxVariants})`);
  };
  const whitespace = (): void => {
    match(whitespacePattern);
  };
  const expect = (character: string): void => {
    whitespace();
    if (source[position] !== character) fail(`Expected ${JSON.stringify(character)}`);
    position++;
  };
  const name = (): string => {
    whitespace();
    const result = match(identifier);
    if (result === null) return fail("Expected a placeholder identifier");
    return result[0];
  };
  const message = (nested: boolean, inPlural: boolean, depth: number): ConvertedMessage => {
    if (depth > 32) fail("Message nesting exceeds 32 levels");
    let result = "";
    let text = "";
    let variants = 1;
    const flush = (): void => {
      result += escapeIcuText(text, inPlural);
      text = "";
    };
    while (position < source.length) {
      const char = source[position];
      if (char === "'" && config.useEscaping) {
        position++;
        if (source[position] === "'") {
          text += "'";
          position++;
          continue;
        }
        let closed = false;
        while (position < source.length) {
          const quoted = source[position++];
          if (quoted === "'") {
            if (source[position] === "'") {
              text += "'";
              position++;
            } else {
              closed = true;
              break;
            }
          } else text += quoted ?? "";
        }
        if (!closed)
          fail("Unmatched single quote (use doubled apostrophes when useEscaping is true)");
        continue;
      }
      if (char === "}") {
        if (nested) break;
        if (!config.useRelaxedSyntax) fail("Unexpected closing brace");
      }
      if (char !== "{") {
        text += char ?? "";
        position++;
        continue;
      }
      const nextName = match(nextIdentifier, false)?.[1];
      if (config.useRelaxedSyntax && (nextName === undefined || !placeholders.has(nextName))) {
        text += "{";
        position++;
        continue;
      }
      flush();
      position++;
      const arg = name();
      whitespace();
      if (source[position] === "}") {
        position++;
        result += `{${arg}}`;
        continue;
      }
      expect(",");
      const kind = name();
      expect(",");
      if (kind === "date" || kind === "time") {
        whitespace();
        if (match(skeletonPrefix) === null)
          fail("Flutter inline date/time formats require a ::skeleton");
        const skeleton = name();
        expect("}");
        result += `{${arg}, ${kind}, ::${skeleton}}`;
        continue;
      }
      if (kind !== "select" && kind !== "plural")
        fail(
          `Flutter does not support inline ${JSON.stringify(kind)}; use placeholder metadata for number/date formatting`,
        );
      const cases = new Map<string, ConvertedMessage>();
      for (;;) {
        whitespace();
        if (kind === "plural" && match(offsetPrefix, false) !== null)
          fail("Flutter does not support plural offsets");
        if (source[position] === "}") {
          position++;
          break;
        }
        let key: string;
        if (source[position] === "=" && kind === "plural") {
          position++;
          const numeric = match(number);
          if (numeric === null) return fail("Expected a nonnegative exact plural number");
          key = `=${numeric[0]}`;
          if (!/^=[012]$/.test(key))
            fail("Flutter supports only exact plural values =0, =1 and =2");
        } else {
          // Flutter permits numeric select keys, but not =n select keys.
          const result = match(caseKey);
          if (result === null) return fail("Expected a select/plural case");
          key = result[0];
        }
        if (kind === "plural" && !/^=/.test(key) && !categories.has(key))
          fail(`Invalid plural category ${JSON.stringify(key)}`);
        expect("{");
        const body = message(true, inPlural || kind === "plural", depth + 1);
        expect("}");
        // gen-l10n maps =0/1/2 to zero/one/two and the last case wins.
        const alias = kind === "plural" ? pluralAliases[key] : undefined;
        cases.set(alias ?? key, body);
      }
      if (!cases.has("other")) fail("A select/plural must contain an other case");
      let choiceVariants = 0;
      for (const [key, body] of cases) {
        // zero/one/two bodies also appear in an exact numeric branch.
        const copies = kind === "plural" && ["zero", "one", "two"].includes(key) ? 2 : 1;
        choiceVariants += copies * body.variants;
        bounded(choiceVariants);
      }
      variants *= choiceVariants;
      bounded(variants);
      let exacts = "";
      if (kind === "plural") {
        // Intl.pluralLogic tests numeric 0/1/2 before applying CLDR rules.
        for (const [category, exact] of [
          ["zero", "=0"],
          ["one", "=1"],
          ["two", "=2"],
        ] as const) {
          const body = cases.get(category);
          if (body !== undefined) exacts += ` ${exact} {${body.source}}`;
        }
      }
      result += `{${arg}, ${kind},${exacts}${[...cases].map(([key, body]) => ` ${key} {${body.source}}`).join("")}}`;
    }
    flush();
    return { source: result, variants };
  };
  return message(false, false, 0).source;
}

/** Guard the expansion before the ICU mapper constructs a Cartesian variant table. */
export function validateIcu(source: string, maxVariants: number): IcuPart[] {
  return parseIcu(source, maxVariants);
}

/** Render a canonical ICU message using Flutter's apostrophe and # semantics. */
export function icuToFlutter(
  source: string,
  config: ResolvedSettings,
  placeholders: ReadonlySet<string>,
): string {
  const literal = (text: string): string => {
    if (config.useEscaping) return escapeIcuText(text, false);
    if (/[{}]/.test(text)) {
      if (
        !config.useRelaxedSyntax ||
        [...text.matchAll(/\{\s*([a-zA-Z_][a-zA-Z0-9_]*)/g)].some((match) =>
          placeholders.has(match[1] ?? ""),
        )
      ) {
        throw new ArbError(
          "Literal braces require useEscaping: true (and use-escaping: true in l10n.yaml)",
        );
      }
    }
    return text;
  };
  const render = (parts: IcuPart[]): string =>
    parts
      .map((part): string => {
        switch (part.type) {
          case "text":
            return literal(part.value);
          case "argument":
            return `{${part.name}}`;
          case "formatter": {
            if (
              (part.formatter !== "date" && part.formatter !== "time") ||
              part.style === undefined ||
              !/^::[a-zA-Z_][a-zA-Z0-9_]*$/.test(part.style)
            ) {
              throw new ArbError(
                `Flutter cannot export inline ${part.formatter}; use ARB placeholder metadata`,
              );
            }
            return `{${part.name}, ${part.formatter}, ${part.style}}`;
          }
          case "pound":
            throw new ArbError(
              "Flutter does not substitute ICU #; interpolate the plural variable instead",
            );
          case "choice": {
            if (part.kind === "selectordinal")
              throw new ArbError("Flutter does not support selectordinal");
            if (part.offset !== 0) throw new ArbError("Flutter does not support plural offsets");
            const cases = new Map(part.cases.map((entry) => [entry.key, render(entry.parts)]));
            if (part.kind === "plural") {
              for (const [exact, category] of Object.entries(pluralAliases)) {
                if (category === undefined) continue;
                const exactBody = cases.get(exact);
                const categoryBody = cases.get(category);
                if (
                  (exactBody !== undefined || categoryBody !== undefined) &&
                  exactBody !== categoryBody
                ) {
                  throw new ArbError(
                    `Flutter cannot distinguish ${exact} from ${category}; both patterns must be present and agree`,
                  );
                }
              }
              for (const [key, body] of cases) {
                if (!/^=/.test(key)) continue;
                const alias = pluralAliases[key];
                if (alias === undefined)
                  throw new ArbError("Flutter supports only exact plural values =0, =1 and =2");
                cases.set(alias, body);
                cases.delete(key);
              }
            }
            return `{${part.name}, ${part.kind},${[...cases].map(([key, body]) => ` ${key} {${body}}`).join("")}}`;
          }
          default: {
            const unexpected: never = part;
            throw new ArbError(`Unknown ICU pattern part: ${JSON.stringify(unexpected)}`);
          }
        }
      })
      .join("");
  return render(parseIcu(source, config.maxVariants));
}
