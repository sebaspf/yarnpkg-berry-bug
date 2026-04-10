# Yarn PnP + TypeScript: Recursive Directory Watcher Bug

Minimal reproduction for a bug where TypeScript's `tsserver`, running under Yarn PnP,
creates a **recursive directory watcher on an arbitrary directory** derived from the
first 12 characters of the project's absolute path, causing VS Code to hang.

The bug triggers when `indexOf("/node_modules/")` returns `-1` for a PnP workspace path.
The arithmetic `substring(0, -1 + 14 - 1)` always produces `substring(0, 12)`. If those
12 characters form a valid directory with many files (e.g., `$HOME`), tsserver tries to
watch it recursively. The severity depends on whether that 12-char prefix resolves
to a large directory or not.

**Path examples** — result depends on project location (only tested on linux):

| Project under | `substring(0,12)` | Effect |
|---|---|---|
| `/home/alice/...` | `/home/alice/` | Watches all of `$HOME` — **hangs** |
| `/Users/alice/...` | `/Users/alice` | Watches all of `$HOME` — **hangs** |
| `C:\Users\bob\...` | `C:\Users\bob\` | Watches all of `%USERPROFILE%` — **hangs** |
| `/home/a/proj/...` | `/home/a/proj` | Probably invalid — no visible hang |
| `/tmp/dev/app/...` | `/tmp/dev/app` | Probably invalid — no visible hang |

See [ISSUE-yarnpkg-berry.md](./ISSUE-yarnpkg-berry.md) for the full bug report.

## Reproduce

The bug manifests when `substring(0, 12)` of the project path produces a valid directory.
Clone the repo under a path where this is the case (e.g., directly under `$HOME`).

```bash
# 1. Install and build
yarn install
yarn workspace shared build

# 2. Open in VS Code (must use the PnP TypeScript SDK)
code .

# 3. When prompted, select "Use Workspace Version" for TypeScript

# 4. restart VS Code

# 5. Open app/src/index.ts and save (it may need some change and save a few times)
#    → source.addMissingImports fires
#    → tsserver computes module specifiers for 'shared'
#    → Bug: recursive watcher created on substring(0,12) of the path
#    → If that matches a large directory (e.g. $HOME), VS Code hangs
```

## Workaround

Apply the included patch (or checkout the fix branch) to guard `indexOf` against
returning `-1`:

```bash
# In the main package.json, change the typescript dependency to:
#   "typescript": "patch:typescript@npm%3A5.9.3#./patches/typescript-npm-5.9.3-48715be868.patch"
# Then:
yarn install
yarn dlx @yarnpkg/sdks vscode
# Restart VS Code
# Open app/src/index.ts and save
```

## Structure

```
├── shared/          # Library workspace (builds to dist/)
│   └── src/index.ts # Exports User, greet, DEFAULT_USER
├── app/             # Consumer workspace
│   └── src/index.ts # Uses shared symbols WITHOUT importing them
├── patches/         # Workaround patch for typescript
└── .vscode/         # Settings: source.addMissingImports on save
```
