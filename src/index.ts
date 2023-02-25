import type * as ast from "@inlang/core/ast";
import type { Config, EnvironmentFunctions } from "@inlang/core/config";

export type PluginConfig = {
  pathPattern: string;
};

export async function readResources(
  args: Parameters<Config["readResources"]>[0] &
    EnvironmentFunctions & { pluginConfig: PluginConfig }
): ReturnType<Config["readResources"]> {
  const result: ast.Resource[] = [];
  for (const language of args.config.languages) {
    const resourcePath = args.pluginConfig.pathPattern.replace(
      "{language}",
      language
    );
    const arbContent = (await args.$fs.readFile(
      resourcePath,
      "utf-8"
    )) as string;
    const resource = parseResource(arbContent, language);
    result.push(resource);
  }
  return result;
}

export async function writeResources(
  args: Parameters<Config["writeResources"]>[0] &
    EnvironmentFunctions & { pluginConfig: PluginConfig }
): ReturnType<Config["writeResources"]> {
  for (const resource of args.resources) {
    const resourcePath = args.pluginConfig.pathPattern.replace(
      "{language}",
      resource.languageTag.name
    );
    const arbContent = serializeResource(resource);
    await args.$fs.writeFile(resourcePath, arbContent);
  }
}

function parseResource(arbContent: string, language: string): ast.Resource {
  const arbObject = JSON.parse(arbContent);
  return {
    type: "Resource",
    languageTag: {
      type: "LanguageTag",
      name: language,
    },
    body: Object.entries(arbObject).map(([id, message]) =>
      parseMessage(id, message)
    ),
  };
}

function parseMessage(id: string, message: any): ast.Message {
  return {
    type: "Message",
    id: {
      type: "Identifier",
      name: id,
    },
    pattern: {
      type: "Pattern",
      elements: [{ type: "Text", value: message.toString() }],
    },
  };
}

function serializeResource(resource: ast.Resource): string {
  const arbObject = Object.fromEntries(resource.body.map(serializeMessage));
  return JSON.stringify(arbObject, null, 2);
}

function serializeMessage(message: ast.Message): [id: string, value: any] {
  return [message.id.name, message.pattern.elements[0].value];
}
