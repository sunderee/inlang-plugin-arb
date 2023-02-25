import type * as ast from "@inlang/core/ast";
import type { Config } from "@inlang/core/config";

/**
 * Reading resources. At the moment, the plugin does not support custom path
 * pattern for reading resources, as it assumes you're following the official
 * documentation guidelines:
 *
 * https://docs.flutter.dev/development/accessibility-and-localization/internationalization
 *
 * As a recap, you should have a `l10n.yaml` with contents similar to:
 *
 * ```yaml
 * arb-dir: lib/l10n
 * template-arb-file: app_en.arb
 * output-localization-file: app_localizations.dart
 * ```
 *
 * Therefore, the path pattern follows `./lib/l10n/app_{language}.arb`
 *
 * @param args inlang config schema
 * @returns list of resources
 */
export async function readResources(args: {
  config: Config;
}): Promise<ast.Resource[]> {
  const result: ast.Resource[] = [];
  for (const language of args.config.languages) {
  }

  return result;
}

export async function writeResources(args: {
  config: Config;
  resources: ast.Resource[];
}): Promise<void> {}
