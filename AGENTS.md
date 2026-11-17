# Regras do Workspace ArgusBot

## Fluxo de Git (Commit e Push Automático)

- Sempre que finalizar uma tarefa com alterações de código neste repositório, faça automaticamente o `git commit` das mudanças relevantes usando uma mensagem descritiva no padrão **Conventional Commits** (ex.: `feat(recipes): ...`, `fix(bot): ...`, `chore(...): ...`).
- Em seguida, execute sempre `git pull --rebase origin main` seguido de `git push origin main` para sincronizar eventuais commits do servidor/CI e publicar as mudanças no GitHub.
- Antes de fazer o commit, verifique com `git status` para garantir que arquivos temporários, segredos ou `.env` não sejam incluídos.
