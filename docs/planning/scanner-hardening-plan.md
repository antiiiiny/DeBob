# Scanner Hardening Plan

## Overview

Two pre-Sub-Task-7 hardening changes to `src/scanner/index.ts` that prevent the graph
builder from being fed garbage data:

1. **`.gitignore` / `.debobignore` respect** — the scanner currently uses only a hardcoded
   `DEFAULT_IGNORE` list. Project-specific exclusions (custom output dirs, scratch files,
   generated assets) are silently walked and inflate node/edge counts.

2. **Binary / huge-file safety** — the scanner reads every matched file into memory and
   passes the buffer to `sha256()`. Downstream, the TypeScript analyzer receives raw content
   as a string. A stray binary or a massive generated file (lockfiles, bundles) can either
   crash tree-sitter or produce garbage nodes.

Both fixes are entirely contained within `src/scanner/`. No downstream API surface changes.

---

## Sub-Task A — `.gitignore` / `.debobignore` Respect

**Status:** `[x] done`

**Intent:**
Read `.gitignore` and `.debobignore` at the repo root (if they exist) and apply their rules
as a post-glob filter so that project-specific exclusions are automatically honoured, without
any change to the `ScanOptions` public API.

The `ignore` npm package is the right tool: it is the de-facto gitignore-spec parser used by
ESLint, Prettier, and others. It handles negation (`!pattern`), anchored patterns, and all
other gitignore edge cases that naive glob translation gets wrong.

**Expected Outcomes:**
- `ignore` added as a production dependency in `package.json`.
- `scanRepository` reads `.gitignore` and `.debobignore` from `repoRoot` at call time (missing
  files are silently skipped — not an error).
- Any path that matches the combined gitignore rules is excluded from the returned
  `ScannedFile[]`.
- `DEFAULT_IGNORE` globs are kept as-is (they handle directories before globbing, which is
  faster than post-filtering).
- `ScanOptions` gains an optional `respectGitignore?: boolean` flag (default `true`) so
  callers can opt out if needed (e.g. in unit tests scanning a temp directory with no
  `.gitignore`).
- Existing `extraIgnore` option is unaffected.

**Todo List:**
1. Add `"ignore": "^5.3.2"` to `dependencies` in `package.json`.
2. In `src/scanner/index.ts`, import `ignore` from `'ignore'`.
3. Add `respectGitignore?: boolean` to the `ScanOptions` interface (defaults to `true`).
4. After the glob call, if `respectGitignore !== false`, read `.gitignore` and `.debobignore`
   from `repoRoot` (each wrapped in a try/catch; missing = empty string).
5. Build a single `ignore` instance, add both file contents to it.
6. Filter `absolutePaths` through `ig.ignores(relativePath)` before the per-file loop —
   use `relative(repoRoot, absolutePath).replace(/\\/g, '/')` as the test path.
7. Run `npm install` (or equivalent) to update `package-lock.json`.
8. Run `tsc --noEmit` to confirm no type errors.

**Relevant Context:**
- `ignore` package: `ig = ignore(); ig.add(gitignoreContent); ig.ignores('some/path.ts')`
- Paths passed to `ig.ignores()` must be relative (not absolute) and use forward slashes.
- `.debobignore` already exists as an empty file at the repo root — it is debob's own
  user-facing ignore file (analogous to `.gitignore` but debob-specific).
- The `glob` `dot: false` option already prevents dotfiles from being returned, so gitignore
  patterns for dotfiles (`.env`, `.vscode/`) are handled at glob time; the `ignore` filter
  is a second pass that catches everything else.

---

## Sub-Task B — Binary / Huge-File Safety

**Status:** `[x] done`

**Intent:**
Prevent the scanner from reading binary files or files over a size threshold into memory.
Both problems are caught before `readFileSync` is called, so they have zero runtime cost for
clean repos and safely skip bad files in dirty ones.

Two independent guards:

1. **Size cap** — skip files whose `stat.size` exceeds a constant (1 MB). Large text files
   (minified bundles that slipped past glob, giant lockfiles) are not useful for symbol
   analysis and can stall tree-sitter.

2. **Extension allowlist** — only process files whose extension is in a known-text set.
   Anything not on the list (images, fonts, wasm, zip, binary data, no-extension files) is
   skipped before `readFileSync`. The allowlist covers all extensions the analyzer can act on
   plus common config/source text formats.

Files excluded by either guard are simply absent from the returned `ScannedFile[]`. No error
is thrown; no warning is emitted. The engine's file count accurately reflects what was
analysed.

**Expected Outcomes:**
- A `MAX_FILE_BYTES` constant (1 * 1024 * 1024 = 1 048 576) exported or kept module-private.
- A `TEXT_EXTENSIONS` set covering: all TS/JS extensions already in the language-detection
  sets, plus `.json`, `.jsonc`, `.yaml`, `.yml`, `.toml`, `.md`, `.mdx`, `.txt`, `.html`,
  `.htm`, `.css`, `.scss`, `.sass`, `.less`, `.graphql`, `.gql`, `.xml`, `.svg`,
  `.sh`, `.bash`, `.zsh`, `.fish`, `.env` (not dotfiles — extension only),
  `.prisma`, `.proto`, `.sql`, `.tf`, `.hcl`, `.vue`, `.svelte`, `.astro`.
- In the per-file loop, after `statSync`:
  - If `stats.size > MAX_FILE_BYTES` → `continue`
  - If `ext` is not in `TEXT_EXTENSIONS` → `continue`
- No change to `ScannedFile` interface or any other public type.
- `tsc --noEmit` passes with no new errors.

**Relevant Context:**
- The size check must come before `readFileSync` — that is already where `statSync` is
  called in the existing loop.
- Extension check uses the same `ext` variable already computed in the loop
  (`extname(absolutePath).toLowerCase()`).
- Files with no extension (`ext === ''`) are not in `TEXT_EXTENSIONS` and will be skipped —
  correct behaviour (compiled binaries, scripts without shebangs, etc.).
- The existing `DEFAULT_IGNORE` patterns already exclude `**/*.min.js`, `**/*.map`,
  `**/*.d.ts` at glob time — the extension allowlist is a second, finer-grained safety net.
- `language: 'unknown'` files (e.g. `.json`, `.yaml`) still pass both guards and are
  included in `ScannedFile[]` so the engine can record them in `file_cache`. They are simply
  not passed to any `LanguageAnalyzer`.

---

## Implementation Order

Sub-Task A and Sub-Task B are independent and can be implemented in either order or together
in a single commit. Recommended: implement together as one PR since both touch the same file.

## Files Changed

| File | Change |
|------|--------|
| `package.json` | Add `ignore` dependency |
| `src/scanner/index.ts` | Add gitignore filter + size cap + extension allowlist |
| `src/scanner/types.ts` | No change |
