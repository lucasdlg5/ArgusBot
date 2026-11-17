---
name: argus-release-workflow
description: >-
  Use this skill whenever finishing a task that modifies code or behavior in the
  ArgusBot repository, to bump SemVer in src/config/version.ts and package.json,
  create a Conventional Commit including the version tag (vX.Y.Z), and push to
  origin/main.
---

# ArgusBot Release & Git Workflow

Follow this procedure before concluding any task that changes code, configuration, or behavior in `ArgusBot`.

## Steps

1. **Check workspace state**
   Run `git status -s` to inspect modified/untracked files and ensure no temporary files, secrets, or `.env` are staged.

2. **Bump SemVer (`MAJOR.MINOR.PATCH`)**
   Update both `src/config/version.ts` (`APP_VERSION`) and `package.json` (`"version"`) to the exact same new version:
   - `feat` (new feature) → increment `MINOR` and reset `PATCH` to `0` (e.g. `1.1.0` → `1.2.0`).
   - `fix`, `chore`, `refactor`, `style`, `docs`, `perf`, `test` → increment `PATCH` (e.g. `1.1.0` → `1.1.1`).
   - Breaking change → increment `MAJOR` and reset `MINOR` and `PATCH` to `0` (e.g. `1.1.0` → `2.0.0`).

3. **Commit with Conventional Commits + Version**
   Stage the relevant files and commit including `(vX.Y.Z)` in the commit message so live deployments can be verified easily:
   - Examples: `feat(ui): ... (v1.2.0)`, `fix(bot): ... (v1.1.1)`, `chore(skills): ... (v1.1.1)`

4. **Sync and Push to `origin/main`**
   Run:
   ```bash
   GIT_TERMINAL_PROMPT=0 git pull --rebase origin main && GIT_TERMINAL_PROMPT=0 git push origin main
   ```

5. **Verify**
   Run `git status && git log -n 1 --stat` to confirm `working tree clean` and `Your branch is up to date with 'origin/main'`, then report the published version (`vX.Y.Z`) to the user.
