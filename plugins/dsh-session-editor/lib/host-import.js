import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const config = new URL("../host.json", import.meta.url);
const requireHost = existsSync(config)
  ? createRequire(join(JSON.parse(readFileSync(config, "utf8")).app, "package.json"))
  : createRequire(import.meta.url);

// Installed plugins use the selected host's exact packages and versions.
export const importHost = name => import(pathToFileURL(requireHost.resolve(name)).href);
