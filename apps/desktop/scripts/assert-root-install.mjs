import { accessSync, readFileSync } from "fs"
import { createRequire } from "module"
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

const app = resolve(import.meta.dirname, "..")
const root = resolve(import.meta.dirname, "..", "..", "..")

try {
  accessSync(join(root, "node_modules", "vite", "package.json"))
} catch {
  console.error(`Run from repo root: cd ${root} && npm ci`)
  process.exit(1)
}

// `vite.config.ts` aliases react/react-dom to whatever this workspace resolves,
// and React refuses to run when the two come from different installed copies
// ("Minified React error #527" — it throws before the first paint, so the app
// window stays blank). npm stays silent about the split because the hoisted
// react still satisfies react-dom's caret peer range. Fail the build loudly
// instead of shipping a white screen.
const requireFromApp = createRequire(join(app, "package.json"))
const installedVersion = (pkg) =>
  JSON.parse(readFileSync(requireFromApp.resolve(`${pkg}/package.json`), "utf8")).version

const react = installedVersion("react")
const reactDom = installedVersion("react-dom")

if (react !== reactDom) {
  console.error(
    `react@${react} / react-dom@${reactDom} version mismatch — React would fail ` +
      `with error #527 and render a blank window. Pin both to the same version ` +
      `in ${join(app, "package.json")}, then reinstall: cd ${root} && npm ci`
  )
  process.exit(1)
}
