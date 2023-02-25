// src/index.ts
async function readResources(args) {
  const result = [];
  for (const language of args.config.languages) {
    const resourcePath = args.pluginConfig.pathPattern.replace(
      "{language}",
      language
    );
    const json = JSON.parse(
      await args.$fs.readFile(resourcePath, "utf-8")
    );
    result.push(parseResource(json, language));
  }
  return result;
}
async function writeResources(args) {
  for (const resource of args.resources) {
    const resourcePath = args.pluginConfig.pathPattern.replace(
      "{language}",
      resource.languageTag.name
    );
    await args.$fs.writeFile(resourcePath, serializeResource(resource));
  }
}
function parseResource(flatJson, language) {
  return {
    type: "Resource",
    languageTag: {
      type: "LanguageTag",
      name: language
    },
    body: Object.entries(flatJson).map(
      ([id, value]) => parseMessage(id, value)
    )
  };
}
function parseMessage(id, value) {
  return {
    type: "Message",
    id: {
      type: "Identifier",
      name: id
    },
    pattern: { type: "Pattern", elements: [{ type: "Text", value }] }
  };
}
function serializeResource(resource) {
  const json = Object.fromEntries(resource.body.map(serializeMessage));
  return JSON.stringify(json, null, 2);
}
function serializeMessage(message) {
  return [message.id.name, message.pattern.elements[0].value];
}
export {
  readResources,
  writeResources
};
