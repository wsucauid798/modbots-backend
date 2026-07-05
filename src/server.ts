import { buildApp } from "./app.js";
import { BackendClient } from "./backend.js";
import { loadConfig } from "./config.js";
import { createOidcProvider } from "./oidc.js";

const start = async (): Promise<void> => {
  const config = loadConfig();
  const backend = new BackendClient(config.backendUrl);
  const provider = await createOidcProvider(config, backend);
  const app = await buildApp(config, backend, provider);

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
