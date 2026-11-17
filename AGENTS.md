# Regras do Workspace ArgusBot

## Versionamento SemVer e Fluxo de Git (Commit e Push Automático)

- **Versionamento obrigatório a cada commit (SemVer `MAJOR.MINOR.PATCH`):**
  - Antes de cada commit que altere código ou comportamento do projeto, atualize o número de versão em `src/config/version.ts` (`APP_VERSION`) e em `package.json` (`"version"`):
    - `feat` (nova funcionalidade) → incrementa `MINOR` e zera `PATCH` (ex.: `1.1.0` → `1.2.0`).
    - `fix`, `chore`, `refactor`, `style`, `docs`, `perf`, `test` → incrementa `PATCH` (ex.: `1.1.0` → `1.1.1`).
    - Mudança incompatível (*breaking change*) → incrementa `MAJOR` e zera `MINOR` e `PATCH` (ex.: `1.1.0` → `2.0.0`).
- **Commit e descrição da versão:**
  - Sempre que finalizar uma tarefa com alterações de código neste repositório, faça automaticamente o `git commit` das mudanças relevantes usando o padrão **Conventional Commits** incluindo obrigatoriamente a versão atual na descrição do commit (ex.: `feat(ui): ... (v1.1.0)`, `fix(bot): ... (v1.1.1)`), para facilitar verificar se o site/servidor live está atualizado.
- **Push automático:**
  - Em seguida, execute sempre `git pull --rebase origin main` seguido de `git push origin main` para sincronizar eventuais commits do servidor/CI e publicar as mudanças no GitHub, informando a versão publicada ao usuário.
- **Segurança antes do commit:**
  - Antes de fazer o commit, verifique com `git status` para garantir que arquivos temporários, segredos ou `.env` não sejam incluídos.
