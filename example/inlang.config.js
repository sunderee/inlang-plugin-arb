export async function defineConfig(env) {
  const plugin = await env.$import("../dist/index.js");

  const pluginConfig = {
    pathPattern: "./app_{language}.arb",
  };

  return {
    referenceLanguage: "en",
    languages: ["en", "si", 'sr'],
    readResources: (args) =>
      plugin.readResources({ ...args, ...env, pluginConfig }),
    writeResources: (args) =>
      plugin.writeResources({ ...args, ...env, pluginConfig }),
  };
}
