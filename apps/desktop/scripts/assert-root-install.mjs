import { accessSync } from "fs"
import { resolve, join } from "path"

// Fail fast with a readable message before touching any newer-Node API.
// Vite 8 + `import.meta.dirname` (used below) require Node >= 22.22 — older
// runtimes crash with a cryptic ERR_INVALID_ARG_TYPE at the resolve() call.
const [major, minor] = process.versions.node.split(".").map(Number)

if (major < 22 || (major === 22 && minor < 22)) {
  console.error(
    `This workspace needs Node >= 22.22.0 (found ${process.versions.node}). ` +
      `Install a supported runtime (e.g. 'nvm install 22') and retry.`
  )
  process.exit(1)
}

const root = resolve(import.meta.dirname, "..", "..", "..")

try {
  accessSync(join(root, "node_modules", "vite", "package.json"))
} catch {
  console.error(`Run from repo root: cd ${root} && npm ci`)
  process.exit(1)
}
