import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const start = async (): Promise<void> => {
  const config = loadConfig();
  const app = buildApp(config);

  try {
    await app.listen({
      host: config.server.host,
      port: config.server.port,
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
