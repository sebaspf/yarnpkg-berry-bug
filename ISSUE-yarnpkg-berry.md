# Bug: PnP TypeScript compat patch causes tsserver to recursively watch an arbitrary directory

## Describe the bug

Yarn's builtin TypeScript compat patch (`builtin<compat/typescript>`) sets `isInNodeModules = true` for cross-workspace module paths in `getAllModulePathsWorker` (in `src/compiler/moduleSpecifiers.ts`). This is correct for PnP resolution semantics, but downstream TypeScript code in `moduleSpecifierCache.ts` assumes that `isInNodeModules === true` implies the path **literally** contains the string `/node_modules/`. Since PnP workspace paths don't contain `/node_modules/`, an unchecked `indexOf("/node_modules/")` returns `-1`, and the resulting arithmetic **always** produces `substring(0, 12)` — the first 12 characters of the path. If those 12 characters happen to form a valid directory, TypeScript creates a **recursive directory watcher** on it, causing VS Code to hang.

The watched path is always the first 12 characters of the resolved module path. This is **not** limited to `$HOME` — it affects any project whose absolute path starts with a valid 12-character directory prefix. See [Path examples](#path-examples) below.

This was first reported to the TypeScript team ([microsoft/TypeScript#63373](https://github.com/microsoft/TypeScript/issues/63373)), who confirmed this is outside their scope since the `isInNodeModules` invariant is broken by Yarn's compat patch — upstream TypeScript guarantees `isInNodeModules === true` only for paths that literally contain `/node_modules/`.

## To Reproduce

A minimal reproduction repo is available: **[TODO: link to repo]**

### Setup
1. Yarn PnP monorepo with two workspaces: `shared` (library) and `app` (consumer)
2. `shared` builds to `dist/` with `declaration: true`
3. `app` depends on `shared: "workspace:^"` and imports types/values from it
4. VS Code settings include `"source.addMissingImports": "always"` in `editor.codeActionsOnSave`
5. VS Code uses the Yarn PnP TypeScript SDK (`.yarn/sdks/typescript/lib`)

### Steps
1. Clone the project (main branch) to a location matching the [Path examples](#path-examples)
2. Ensure in the path are a large number of files.
3. run `yarn install && yarn workspace shared build`
4. Open the project in VS Code
5. Open `app/src/index.ts` (which has an unresolved symbol exported by `shared`) and edit.
6. Save the file — `source.addMissingImports` triggers `importFixes` → `getModuleSpecifiersWithCacheInfo`
7. **VS Code GUI hangs** as tsserver recursively watches the directory produced by `substring(0, 12)` of the project path (for me `$HOME`)

The trigger is not limited to `source.addMissingImports`. Any operation that calls `getModuleSpecifiersWithCacheInfo` will trigger the bug, including **auto-import completions** (typing and accepting an auto-import suggestion for a symbol from another workspace).

## Root Cause Analysis

### The PnP compat patch

In `packages/plugin-compat/extra/typescript/`, the compat patch modifies `getAllModulePathsWorker` in `src/compiler/moduleSpecifiers.ts`:

```typescript
// Original TypeScript:
let isInNodeModules = pathContainsNodeModules(path);
// ↑ Only true when path literally contains "/node_modules/"

// After Yarn's compat patch:
let isInNodeModules = pathContainsNodeModules(path);
const pnpapi = getPnpApi(path);
if (!isInNodeModules && pnpapi) {
  const fromLocator = pnpapi.findPackageLocator(info.importingSourceFileName);
  const toLocator = pnpapi.findPackageLocator(path);
  if (fromLocator && toLocator && fromLocator !== toLocator) {
    isInNodeModules = true;  // ← Set for cross-workspace refs WITHOUT /node_modules/ in path
  }
}
```

For workspace cross-references (e.g., `app` → `shared`), `findPackageLocator` returns different locators, so `isInNodeModules` becomes `true` even though the path is something like:
```
/home/alice/projects/my-project/shared/dist/index.d.ts
```
which contains no `/node_modules/` segment.

### The downstream bug in TypeScript

In `src/server/moduleSpecifierCache.ts`, the `set()` method trusts `isInNodeModules` and uses `indexOf("/node_modules/")` without checking for `-1`:

```typescript
if (p.isInNodeModules) {
    const nodeModulesPath = p.path.substring(
        0,
        p.path.indexOf(nodeModulesPathPart) + nodeModulesPathPart.length - 1
        //              ↑ Returns -1 for PnP workspace paths!
    );
    host.watchNodeModulesForPackageJsonChanges(nodeModulesPath);
    // ↑ Creates a RECURSIVE directory watcher on the computed path
}
```

When `indexOf` returns `-1`, the arithmetic **always** reduces to `substring(0, 12)`:
```
substring(0, -1 + "/node_modules/".length - 1)
= substring(0, -1 + 14 - 1)
= substring(0, 12)
```

This means the first **12 characters** of the module's resolved path are extracted and used as a directory to watch recursively. The result depends entirely on the project's absolute path.

### Path examples

Note: I have only tested it on Linux

The bug is not specific to any particular directory — it triggers whenever `substring(0, 12)` produces a valid path that contains many files:

| Project path | Module path | `substring(0,12)` | Watched dir | Impact |
|---|---|---|---|---|
| `/home/alice/projects/my-app/...` | `/home/alice/projects/my-app/shared/dist/index.d.ts` | `/home/alice/` | User's home directory | **Severe** — watches all of `$HOME` |
| `/home/a/projects/my-app/...` | `/home/a/proj...` | `/home/a/proj` | Likely invalid path | No impact (path doesn't exist) |
| `/Users/alice/dev/my-app/...` | `/Users/alice...` | `/Users/alice` | macOS home directory | **Severe** — watches all of `$HOME` |
| `/opt/projects/my-app/...` | `/opt/project...` | `/opt/project` | Likely invalid | No impact |
| `/workspace/a/my-app/...` | `/workspace/a...` | `/workspace/a` | Container workspace | **Moderate** — depends on contents |
| `/tmp/dev/proj/my-app/...` | `/tmp/dev/pro...` | `/tmp/dev/pro` | Likely invalid | No impact |
| `/var/www/html/my-app/...` | `/var/www/htm...` | `/var/www/htm` | Likely invalid | No impact |
| `C:\Users\bob\projects\...` | `C:\Users\bob...` | `C:\Users\bob\` | Windows home directory | **Severe** — watches all of `%USERPROFILE%` |

**Key insight**: the severity depends on whether the first 12 characters of the project's absolute path happen to form a valid directory containing many files. Users whose username length causes `$HOME` to be exactly 12 characters (e.g., `/home/alice/`, `/Users/alice/`) are most affected, but the problem can manifest anywhere where the 12-character prefix resolves to a large directory.

Even when `substring(0, 12)` doesn't produce a valid path (and the watcher silently fails), the bug still wastes resources attempting to set up the watch and may produce confusing error logs.

### There is a second instance of the same bug

In `src/compiler/moduleNameResolver.ts`, `readPackageJsonPeerDependencies()`:

```typescript
const nodeModules = packageDirectory.substring(
    0,
    packageDirectory.lastIndexOf("node_modules") + "node_modules".length
) + directorySeparator;
```

Same pattern: `lastIndexOf` returns `-1`, producing `substring(0, -1 + 12) + "/"` = `substring(0, 11) + "/"` — the first 11 characters of the path plus a `/`. This truncated prefix is then used to resolve peer dependency `package.json` files from an incorrect directory.

## Suggested Fix

The fix can be applied in Yarn's compat patch by guarding the `indexOf` result before using it. This is a one-line guard in each location:

### Fix for Bug 1 (`moduleSpecifierCache.ts:42`):

```typescript
if (p.isInNodeModules) {
    const nodeModulesIndex = p.path.indexOf(nodeModulesPathPart);
    if (nodeModulesIndex !== -1) {  // ← Guard: skip if no /node_modules/ in path
        const nodeModulesPath = p.path.substring(0, nodeModulesIndex + nodeModulesPathPart.length - 1);
        const key = host.toPath(nodeModulesPath);
        if (!containedNodeModulesWatchers?.has(key)) {
            (containedNodeModulesWatchers ||= new Map()).set(
                key,
                host.watchNodeModulesForPackageJsonChanges(nodeModulesPath),
            );
        }
    }
}
```

### Fix for Bug 2 (`moduleNameResolver.ts:2426`):

```typescript
const nodeModulesIdx = packageDirectory.lastIndexOf("node_modules");
if (nodeModulesIdx === -1) return undefined;  // ← Guard: no node_modules in path
const nodeModules = packageDirectory.substring(0, nodeModulesIdx + "node_modules".length) + directorySeparator;
```

Skipping the watcher when the path has no `/node_modules/` is safe: workspace packages are already tracked by normal project file watchers, and PnP zip-cached packages (from `.yarn/cache/`) **do** have `/node_modules/` in their extracted paths, so they continue to be watched correctly.

### Alternative: fix the `isInNodeModules` semantics

Instead of patching downstream consumers, the compat patch could be modified to not set `isInNodeModules = true` for workspace packages. However, this may affect other TypeScript behavior that relies on the `isInNodeModules` flag for cross-package import resolution. The guard approach is safer and more surgical.

## Environment

- **Yarn**: 4.12.0
- **TypeScript**: 5.9.3 (also confirmed on 5.8.3 and 6.0.2)
- **Node**: v24.11.0
- **OS**: Linux
- **VS Code**: with Yarn PnP SDK (`@yarnpkg/sdks vscode`)

## Workaround

Apply a `yarn patch` to TypeScript that adds the `-1` guards. A patch file is included in the reproduction repo under `patches/`.

Alternatively, open the project from a path whose first 12 characters do **not** form a valid directory:
```bash
ln -s /home/alice/projects/my-project /tmp/my-project
cd /tmp/my-project && code .
# substring(0, 12) → "/tmp/my-proj" — not a valid directory
```
