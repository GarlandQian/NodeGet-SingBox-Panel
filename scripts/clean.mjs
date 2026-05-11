import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

await rm(join(root, "extension", "resources"), {
  recursive: true,
  force: true,
});

await rm(join(root, "dist"), {
  recursive: true,
  force: true,
});
