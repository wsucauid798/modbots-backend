import path from "node:path";
import { fileURLToPath } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFile);
const projectRoot = path.resolve(thisDir, "..");

export interface UppsConfig {
  server: {
    host: string;
    port: number;
  };
  publicDir: string;
}

export const loadConfig = (): UppsConfig => ({
  server: {
    host: process.env.MODBOTS_UPPS_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.MODBOTS_UPPS_PORT ?? "3010", 10),
  },
  publicDir:
    process.env.MODBOTS_UPPS_PUBLIC_DIR ??
    path.join(projectRoot, "public"),
});
