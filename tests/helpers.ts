import type { Bundle, Message, Pattern, Variant } from "@inlang/sdk";
import { exportFiles, importFiles } from "../src/index.js";
import { type ArbSettings, canonicalLocale } from "../src/settings.js";

export function settings(config: ArbSettings = {}, locales = ["en", "de"]) {
  return {
    baseLocale: locales[0] ?? "en",
    locales,
    modules: [],
    "plugin.inlang.arb": config,
  };
}

export function file(locale: string, document: unknown) {
  return {
    locale,
    content: new TextEncoder().encode(
      typeof document === "string" ? document : JSON.stringify(document),
    ),
  };
}

export function materialize(data: ReturnType<typeof importFiles>): {
  bundles: Bundle[];
  messages: Message[];
  variants: Variant[];
} {
  const messages = data.messages.map((message, index) => ({
    ...message,
    id: `message-${index}`,
    selectors: message.selectors ?? [],
  }));
  return {
    bundles: data.bundles,
    messages,
    variants: data.variants.map((variant, index) => {
      const message = messages.find(
        (candidate) =>
          candidate.bundleId === variant.messageBundleId &&
          candidate.locale === variant.messageLocale,
      );
      if (message === undefined) throw new Error("Missing message");
      return {
        id: `variant-${index}`,
        messageId: message.id,
        pattern: variant.pattern ?? [],
        matches: variant.matches ?? [],
      };
    }),
  };
}

export function importRows(documents: unknown[], config: ArbSettings = {}, locales = ["en", "de"]) {
  const projectSettings = settings(config, locales);
  const files = documents.map((document, index) => file(locales[index] ?? "en", document));
  return {
    ...materialize(importFiles({ files, settings: projectSettings })),
    settings: projectSettings,
  };
}

export async function roundtrip(
  documents: unknown[],
  config: ArbSettings = {},
  locales = ["en", "de"],
) {
  const rows = importRows(documents, config, locales);
  const exported = await exportFiles(rows);
  return exported.map(
    (entry) => JSON.parse(new TextDecoder().decode(entry.content)) as Record<string, unknown>,
  );
}

/** Evaluate the native inlang shape independently of the plugin's Flutter-to-ICU adapter. */
export function evaluateRows(
  rows: ReturnType<typeof importRows>,
  key: string,
  locale: string,
  inputs: Record<string, string | number>,
): string {
  const message = rows.messages.find(
    (entry) => entry.bundleId === key && canonicalLocale(entry.locale) === canonicalLocale(locale),
  );
  const bundle = rows.bundles.find((entry) => entry.id === key);
  if (message === undefined || bundle === undefined) throw new Error("Missing message");
  const variables: Record<string, string | number> = { ...inputs };
  for (const declaration of bundle.declarations) {
    if (
      declaration.type !== "local-variable" ||
      declaration.value.arg.type !== "variable-reference"
    )
      continue;
    const value = variables[declaration.value.arg.name];
    if (value === undefined) continue;
    variables[declaration.name] =
      declaration.value.annotation?.name === "plural"
        ? new Intl.PluralRules(locale).select(Number(value))
        : value;
  }
  const candidates = rows.variants.filter(
    (variant) =>
      variant.messageId === message.id &&
      variant.matches.every(
        (match) => match.type === "catchall-match" || String(variables[match.key]) === match.value,
      ),
  );
  candidates.sort((a, b) => {
    for (const selector of message.selectors) {
      const aMatch =
        a.matches.find((match) => match.key === selector.name)?.type === "literal-match" ? 0 : 1;
      const bMatch =
        b.matches.find((match) => match.key === selector.name)?.type === "literal-match" ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
    }
    return 0;
  });
  const variant = candidates[0];
  if (variant === undefined) throw new Error("No matching variant");
  return render(variant.pattern);
  function render(pattern: Pattern): string {
    return pattern
      .map((part) =>
        part.type === "text"
          ? part.value
          : part.type === "expression" && part.arg.type === "variable-reference"
            ? String(variables[part.arg.name])
            : "UNSUPPORTED",
      )
      .join("");
  }
}
