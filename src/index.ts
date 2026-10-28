import { type ParsedMessage, parseMessage, serializeMessage } from "@inlang/plugin-icu1";
import type { Bundle, InlangPlugin, MessageImport, Variant, VariantImport } from "@inlang/sdk";
import { keepUnchangedJsonEntries } from "@inlang/sdk/json-formatting";
import { ArbError, errorMessage } from "./error.js";
import { flutterToIcu, icuToFlutter, validateIcu } from "./flutter.js";
import { isObject, type JsonObject, object, parseArb } from "./json.js";
import {
  type ArbFileMetadata,
  collectMetadata,
  createMetadataBundle,
  isLiteralResource,
  metadataIdPattern,
  orderDocument,
  placeholderNames,
  readMetadataBundle,
  validateAttributes,
} from "./metadata.js";
import { namespaceLocals, validateModel } from "./model.js";
import {
  type ArbSettings,
  canonicalLocale,
  fileLocale,
  filePath,
  pluginKey,
  resolveSettings,
  settingsSchema,
} from "./settings.js";

type Plugin = InlangPlugin<{ [pluginKey]?: ArbSettings }>;
type ImportArgs = Parameters<NonNullable<Plugin["importFiles"]>>[0];
type ExportArgs = Parameters<NonNullable<Plugin["exportFiles"]>>[0];
const flutterResourceId = /^[a-z$][a-zA-Z0-9_$]*$/;

function validateLocaleAttribute(document: JsonObject, locale: string, context: string): void {
  const declared = document["@@locale"];
  if (declared === undefined) return;
  if (typeof declared !== "string") throw new ArbError("@@locale must be a string", context);
  if (canonicalLocale(declared) !== canonicalLocale(locale))
    throw new ArbError("@@locale does not match the file locale", context);
}

export function importFiles({ files, settings }: ImportArgs): {
  bundles: Bundle[];
  messages: MessageImport[];
  variants: VariantImport[];
} {
  const config = resolveSettings(settings);
  const baseLocale = canonicalLocale(settings.baseLocale);
  const documents = files.map((file) => {
    const path = filePath(file.locale, config);
    const context = `${path} (${file.locale})`;
    const locale = settings.locales.find(
      (candidate) => canonicalLocale(candidate) === canonicalLocale(file.locale),
    );
    if (locale === undefined)
      throw new ArbError("File locale is not configured in project locales", context);
    const document = parseArb(file.content, context);
    validateAttributes(document, context);
    validateLocaleAttribute(document, file.locale, context);
    return { ...file, locale, document, context };
  });
  if (new Set(documents.map((file) => file.locale)).size !== documents.length)
    throw new ArbError("Only one ARB file per locale is supported; duplicate file locale");
  const template =
    documents.find((file) => canonicalLocale(file.locale) === baseLocale)?.document ?? object();
  const parsedByKey = new Map<string, { locale: string; parsed: ParsedMessage }[]>();
  const bundles: Bundle[] = [];
  const messages: MessageImport[] = [];
  const variants: VariantImport[] = [];
  for (const file of documents) {
    bundles.push(createMetadataBundle(collectMetadata(file.document, file.locale)));
    for (const [key, value] of Object.entries(file.document)) {
      if (/^@/.test(key)) continue;
      const context = `${file.context}, message ${JSON.stringify(key)}`;
      try {
        if (key.length === 0) throw new ArbError("Resource IDs cannot be empty");
        if (config.syntax === "flutter" && !flutterResourceId.test(key))
          throw new ArbError("Flutter resource IDs must be public Dart identifiers");
        if (typeof value !== "string") throw new ArbError("ARB resource values must be strings");
        const literalResource = isLiteralResource(file.document, template, key);
        const placeholders = placeholderNames(template, key);
        const source = literalResource
          ? null
          : config.syntax === "flutter"
            ? flutterToIcu(value, config, placeholders)
            : value;
        let parsed: ParsedMessage;
        if (source === null) {
          parsed = {
            declarations: [],
            selectors: [],
            variants: [
              {
                messageBundleId: key,
                messageLocale: file.locale,
                matches: [],
                pattern: [{ type: "text", value }],
              },
            ],
          };
        } else {
          validateIcu(source, config.maxVariants);
          parsed = parseMessage({
            messageSource: source,
            bundleId: key,
            locale: canonicalLocale(file.locale),
          });
          parsed.variants = parsed.variants.map((variant) => ({
            messageBundleId: key,
            messageLocale: file.locale,
            matches: variant.matches ?? [],
            pattern: variant.pattern ?? [],
          }));
          if (parsed.variants.length > config.maxVariants)
            throw new ArbError(`Message exceeds maxVariants (${config.maxVariants})`);
        }
        const entries = parsedByKey.get(key) ?? [];
        entries.push({ locale: file.locale, parsed });
        parsedByKey.set(key, entries);
      } catch (cause) {
        throw new ArbError(errorMessage(cause), context, { cause });
      }
    }
  }
  for (const [key, entries] of parsedByKey) {
    const inputs = new Set(
      entries.flatMap((entry) =>
        entry.parsed.declarations
          .filter((decl) => decl.type === "input-variable")
          .map((decl) => decl.name),
      ),
    );
    const declarations: Bundle["declarations"] = [...inputs].map((name) => ({
      type: "input-variable",
      name,
    }));
    for (const entry of entries) {
      const parsed = namespaceLocals(entry.parsed, canonicalLocale(entry.locale), inputs);
      declarations.push(...parsed.declarations.filter((decl) => decl.type === "local-variable"));
      messages.push({
        bundleId: key,
        locale: entry.locale,
        selectors: parsed.selectors,
      });
      variants.push(...parsed.variants);
    }
    bundles.push({ id: key, declarations });
  }
  return { bundles, messages, variants };
}

/** Whole-file export; public exportFiles additionally preserves existing entry bytes. */
export function exportWholeFiles({
  bundles,
  messages,
  variants,
  settings,
}: ExportArgs): ReturnType<NonNullable<Plugin["exportFiles"]>> {
  const config = resolveSettings(settings);
  const baseLocale = canonicalLocale(settings.baseLocale);
  const metadata = new Map<string, ArbFileMetadata>();
  const byBundle = new Map<string, Bundle>();
  for (const bundle of bundles) {
    if (byBundle.has(bundle.id)) throw new ArbError(`Duplicate bundle ${bundle.id}`);
    byBundle.set(bundle.id, bundle);
    if (metadataIdPattern.test(bundle.id)) {
      const entry = readMetadataBundle(bundle);
      const locale = canonicalLocale(entry.locale);
      if (metadata.has(locale)) throw new ArbError(`Duplicate metadata for locale ${locale}`);
      metadata.set(locale, entry);
    }
  }
  const byMessage = new Map<string, Variant[]>();
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const bundleVariants = new Map<string, Variant[]>();
  if (messageById.size !== messages.length) throw new ArbError("Duplicate message IDs");
  for (const variant of variants) {
    const message = messageById.get(variant.messageId);
    if (message === undefined)
      throw new ArbError(`Variant references missing message ${variant.messageId}`);
    const list = byMessage.get(variant.messageId) ?? [];
    list.push(variant);
    byMessage.set(variant.messageId, list);
    const forBundle = bundleVariants.get(message.bundleId) ?? [];
    forBundle.push(variant);
    bundleVariants.set(message.bundleId, forBundle);
  }
  const result = [];
  // Flutter takes its placeholder signature from the template, including in relaxed mode.
  const templateAttributes = structuredClone(metadata.get(baseLocale)?.attributes ?? object());
  const baseKeys = new Set(
    messages
      .filter((message) => canonicalLocale(message.locale) === baseLocale)
      .map((message) => message.bundleId),
  );
  for (const key of Object.keys(templateAttributes)) {
    if (/^@(?!@)/.test(key) && !baseKeys.has(key.replace(/^@/, ""))) delete templateAttributes[key];
  }
  const originalBaseKeys = new Set(metadata.get(baseLocale)?.keys);
  for (const bundle of bundles) {
    if (metadataIdPattern.test(bundle.id) || !baseKeys.has(bundle.id)) continue;
    if (config.syntax !== "flutter") continue;
    if (originalBaseKeys.has(bundle.id) && !config.useRelaxedSyntax) continue;
    const inputs = bundle.declarations.filter(
      (declaration) => declaration.type === "input-variable",
    );
    if (inputs.length === 0) continue;
    const attribute = templateAttributes[`@${bundle.id}`];
    const attributes = isObject(attribute) ? attribute : object();
    const existingPlaceholders = attributes["placeholders"];
    const placeholders = isObject(existingPlaceholders) ? existingPlaceholders : object();
    for (const input of inputs) {
      if (Object.hasOwn(placeholders, input.name)) continue;
      const numeric = bundle.declarations.some(
        (declaration) =>
          declaration.type === "local-variable" &&
          declaration.value.arg.type === "variable-reference" &&
          declaration.value.arg.name === input.name &&
          declaration.value.annotation?.name === "plural",
      );
      const date = (bundleVariants.get(bundle.id) ?? []).some((variant) =>
        variant.pattern.some(
          (part) =>
            part.type === "expression" &&
            part.arg.type === "variable-reference" &&
            part.arg.name === input.name &&
            (part.annotation?.name === "date" || part.annotation?.name === "time"),
        ),
      );
      placeholders[input.name] = {
        type: numeric ? "num" : date ? "DateTime" : "String",
      };
    }
    attributes["placeholders"] = placeholders;
    templateAttributes[`@${bundle.id}`] = attributes;
  }
  for (const locale of settings.locales) {
    const canonical = canonicalLocale(locale);
    const previous = metadata.get(canonical);
    const localized = messages.filter((message) => canonicalLocale(message.locale) === canonical);
    if (previous === undefined && localized.length === 0) continue;
    const document = object();
    const currentKeys = new Set(localized.map((message) => message.bundleId));
    if (currentKeys.size !== localized.length)
      throw new ArbError(`Duplicate messages for locale ${locale}`);
    const previousKeys = new Set(previous?.keys);
    for (const [key, value] of Object.entries(previous?.attributes ?? {})) {
      const resource = key.replace(/^@/, "");
      if (/^@@/.test(key) || !previousKeys.has(resource) || currentKeys.has(resource))
        document[key] = value;
    }
    if (canonical === baseLocale) {
      for (const key of currentKeys) {
        const attribute = templateAttributes[`@${key}`];
        if (attribute !== undefined) document[`@${key}`] = attribute;
      }
    }
    if (previous === undefined)
      document["@@locale"] =
        config.syntax === "flutter" ? canonical.replace(/-/g, "_") : fileLocale(locale, config);
    for (const message of localized) {
      const context = `${filePath(locale, config)} (${locale}), message ${JSON.stringify(message.bundleId)}`;
      try {
        if (
          /^@/.test(message.bundleId) ||
          (config.syntax === "flutter" && !flutterResourceId.test(message.bundleId))
        )
          throw new ArbError("Invalid ARB resource ID");
        const bundle = byBundle.get(message.bundleId);
        if (bundle === undefined) throw new ArbError("Message references a missing bundle");
        const messageVariants = byMessage.get(message.id) ?? [];
        const usedInputs = validateModel(bundle, message, messageVariants, config.maxVariants);
        const literalResource = isLiteralResource(document, templateAttributes, bundle.id);
        if (literalResource) {
          const onlyVariant = messageVariants[0];
          if (
            messageVariants.length !== 1 ||
            onlyVariant === undefined ||
            onlyVariant.pattern.some((part) => part.type !== "text")
          )
            throw new ArbError("Non-text ARB resources must contain only literal text");
          document[bundle.id] = onlyVariant.pattern
            .map((part) => (part.type === "text" ? part.value : ""))
            .join("");
        } else {
          const source = serializeMessage({
            bundle,
            message: { ...message, locale: canonical },
            variants: messageVariants,
          });
          const names = new Set(
            bundle.declarations
              .filter((decl) => decl.type === "input-variable")
              .map((decl) => decl.name)
              .concat([...placeholderNames(templateAttributes, bundle.id)]),
          );
          const rendered =
            config.syntax === "flutter" ? icuToFlutter(source, config, names) : source;
          document[bundle.id] = rendered;
          const normalized =
            config.syntax === "flutter"
              ? flutterToIcu(
                  rendered,
                  config,
                  config.useRelaxedSyntax ? placeholderNames(templateAttributes, bundle.id) : names,
                )
              : rendered;
          if (config.syntax === "flutter" && config.useRelaxedSyntax) {
            const recognized = placeholderNames(templateAttributes, bundle.id);
            if ([...usedInputs].some((input) => !recognized.has(input)))
              throw new ArbError(
                "Relaxed syntax requires placeholder metadata in an existing base-locale message",
              );
          }
          validateIcu(normalized, config.maxVariants);
        }
      } catch (cause) {
        throw new ArbError(errorMessage(cause), context, { cause });
      }
    }
    validateAttributes(document, filePath(locale, config));
    validateLocaleAttribute(document, locale, filePath(locale, config));
    const path = filePath(locale, config);
    result.push({
      locale,
      name: path.match(/[^/]+$/)?.[0] ?? path,
      metadata: { pathPattern: path },
      content: new TextEncoder().encode(
        `${JSON.stringify(orderDocument(document, previous), null, config.indentation)}\n`,
      ),
    });
  }
  for (const message of messages)
    if (
      !settings.locales.some(
        (locale) => canonicalLocale(locale) === canonicalLocale(message.locale),
      )
    )
      throw new ArbError(`Message locale ${message.locale} is not configured`);
  return result;
}

export async function exportFiles(
  args: ExportArgs,
): Promise<Awaited<ReturnType<NonNullable<Plugin["exportFiles"]>>>> {
  const bundles = [...args.bundles];
  const represented = new Set(
    bundles
      .filter((bundle) => metadataIdPattern.test(bundle.id))
      .map((bundle) => canonicalLocale(readMetadataBundle(bundle).locale)),
  );
  for (const file of args.files ?? []) {
    if (file.imported !== true || represented.has(canonicalLocale(file.locale))) continue;
    try {
      bundles.push(
        createMetadataBundle(collectMetadata(parseArb(file.content, file.path), file.locale)),
      );
    } catch {
      /* Invalid previous files are handled by the SDK's formatting fallback. */
    }
  }
  return keepUnchangedJsonEntries({
    exported: await exportWholeFiles({ ...args, bundles }),
    files: args.files,
    settings: args.settings,
    importFiles,
    exportFiles: exportWholeFiles,
    splitKey: (key) => [key],
    isEntry: (path) => path.length === 1,
    indent: " ".repeat(resolveSettings(args.settings).indentation),
  });
}

export const plugin: Plugin & {
  toBeImportedFiles: NonNullable<Plugin["toBeImportedFiles"]>;
  importFiles: typeof importFiles;
  exportFiles: typeof exportFiles;
} = {
  key: pluginKey,
  settingsSchema,
  toBeImportedFiles: ({ settings }) => {
    const config = resolveSettings(settings);
    return settings.locales.map((locale) => ({
      locale,
      path: filePath(locale, config),
    }));
  },
  importFiles,
  exportFiles,
} satisfies Plugin;

export default plugin;
export type { ArbFileMetadata, ArbSettings };
export { ArbError, createMetadataBundle, readMetadataBundle, settingsSchema };
