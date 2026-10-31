import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { engineRuntime } from "./runtime.js";
engineRuntime.exists = existsSync;
engineRuntime.read = file => JSON.parse(readFileSync(file, "utf8"));
engineRuntime.write = (file, store) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(file + ".tmp", file);
};
