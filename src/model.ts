import type { ParsedMessage } from "@inlang/plugin-icu1";
import type {
  Bundle,
  Declaration,
  Expression,
  Message,
  Pattern,
  VariableReference,
  Variant,
} from "@inlang/sdk";
import { ArbError } from "./error.js";

/** Namespace derived locals so different locales cannot overwrite each other's selectors. */
export function namespaceLocals(
  parsed: ParsedMessage,
  locale: string,
  inputs: ReadonlySet<string>,
): ParsedMessage {
  const names = new Map<string, string>();
  const suffix = locale.replace(/-/g, "_");
  const used = new Set(inputs);
  for (const declaration of parsed.declarations) {
    if (declaration.type !== "local-variable") continue;
    let name = `${declaration.name}__arb_${suffix}`;
    while (used.has(name)) name += "_";
    used.add(name);
    names.set(declaration.name, name);
  }
  const reference = (ref: VariableReference): VariableReference => ({
    ...ref,
    name: names.get(ref.name) ?? ref.name,
  });
  const expression = (expr: Expression): Expression => ({
    ...expr,
    arg: expr.arg.type === "variable-reference" ? reference(expr.arg) : expr.arg,
    ...(expr.annotation === undefined
      ? {}
      : {
          annotation: {
            ...expr.annotation,
            options: expr.annotation.options.map((option) => ({
              ...option,
              value:
                option.value.type === "variable-reference" ? reference(option.value) : option.value,
            })),
          },
        }),
  });
  return {
    declarations: parsed.declarations.map((declaration) =>
      declaration.type === "input-variable"
        ? declaration
        : {
            ...declaration,
            name: names.get(declaration.name) ?? declaration.name,
            value: expression(declaration.value),
          },
    ),
    selectors: parsed.selectors.map(reference),
    variants: parsed.variants.map((variant) => ({
      ...variant,
      matches: variant.matches?.map((match) => ({
        ...match,
        key: names.get(match.key) ?? match.key,
      })),
      pattern: variant.pattern?.map((part) =>
        part.type === "expression" ? expression(part) : part,
      ),
    })),
  };
}

/** Reject data that ICU1 would otherwise silently omit or approximate. */
export function validateModel(
  bundle: Bundle,
  message: Message,
  variants: Variant[],
  maxVariants: number,
): Set<string> {
  const declarations = new Map<string, Declaration>();
  for (const declaration of bundle.declarations) {
    if (declarations.has(declaration.name))
      throw new ArbError(`Duplicate declaration ${declaration.name}`);
    declarations.set(declaration.name, declaration);
  }
  const selectors = message.selectors.map((selector) => selector.name);
  if (new Set(selectors).size !== selectors.length) throw new ArbError("Duplicate selector");
  if (variants.length === 0) throw new ArbError("A message must have at least one variant");
  if (variants.length > maxVariants)
    throw new ArbError(`Message exceeds maxVariants (${maxVariants})`);
  const patterns = new Set<string>();
  const referencedInputs = new Set<string>();
  const checkReference = (name: string): void => {
    if (!declarations.has(name)) throw new ArbError(`Undeclared variable ${name}`);
    if (declarations.get(name)?.type === "input-variable") referencedInputs.add(name);
  };
  const checkPattern = (pattern: Pattern): void => {
    for (const part of pattern) {
      if (part.type === "expression") {
        if (part.arg.type === "literal")
          throw new ArbError("Literal expressions cannot be represented by ARB; use a text part");
        checkReference(part.arg.name);
        if (declarations.get(part.arg.name)?.type === "local-variable")
          throw new ArbError(
            `Local variable interpolation ${part.arg.name} cannot be represented by ARB`,
          );
        for (const option of part.annotation?.options ?? []) {
          if (option.value.type !== "literal")
            throw new ArbError("Dynamic formatter options cannot be represented by ARB");
          if (
            option.name !== "style" &&
            !(part.annotation?.name === "icu:pound" && option.name === "offset")
          )
            throw new ArbError(`Unsupported formatter option ${option.name}`);
        }
      } else if (part.type !== "text")
        throw new ArbError(
          "Markup nodes cannot be represented by Flutter ARB; use literal HTML text",
        );
    }
  };
  for (const selector of selectors) {
    checkReference(selector);
    const declaration = declarations.get(selector);
    if (declaration?.type !== "local-variable") continue;
    const expression = declaration.value;
    if (
      expression.arg.type !== "variable-reference" ||
      declarations.get(expression.arg.name)?.type !== "input-variable"
    )
      throw new ArbError("Selectors must refer directly to input variables");
    checkReference(expression.arg.name);
    if (expression.annotation !== undefined && expression.annotation.name !== "plural")
      throw new ArbError(`Unsupported selector function ${expression.annotation.name}`);
    for (const option of expression.annotation?.options ?? []) {
      if (option.value.type !== "literal" || !["type", "offset"].includes(option.name))
        throw new ArbError("Unsupported plural selector options");
      if (option.name === "type" && !["cardinal", "ordinal"].includes(option.value.value))
        throw new ArbError("Invalid plural selector type");
      if (option.name === "offset" && !/^\d+$/.test(option.value.value))
        throw new ArbError("Invalid plural selector offset");
    }
  }
  for (const variant of variants) {
    const keys = variant.matches.map((match) => match.key);
    if (new Set(keys).size !== keys.length || keys.some((key) => !selectors.includes(key)))
      throw new ArbError("Variant matches must refer to unique selectors");
    const signature = JSON.stringify(
      selectors.map((key) => {
        const match = variant.matches.find((candidate) => candidate.key === key);
        return match?.type === "literal-match" ? [key, "literal", match.value] : [key, "catchall"];
      }),
    );
    if (patterns.has(signature)) throw new ArbError("Duplicate variant matches");
    patterns.add(signature);
    checkPattern(variant.pattern);
  }
  if (
    !variants.some((variant) =>
      variant.matches.every((match) => match.type === "catchall-match" || match.value === "other"),
    )
  )
    throw new ArbError("A message must have a fallback variant");
  return referencedInputs;
}
