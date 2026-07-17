import { fileURLToPath, pathToFileURL } from "node:url";

const env = { ...process.env };

env.PORT ??= "3313";
env.ACCOUNT_ISSUER ??= `http://localhost:${env.PORT}`;

const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
process.env.PORT = env.PORT;
process.env.ACCOUNT_ISSUER = env.ACCOUNT_ISSUER;
process.argv = [process.execPath, tsxCli, "watch", "src/server.ts"];

await import(pathToFileURL(tsxCli).href);
