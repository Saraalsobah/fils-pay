# AI setup (team S^2)

- `/CLAUDE.md`, `/AGENTS.md`, `/.cursorrules`: agent instructions. We rewrote them: the originals contained
  false rules (cents instead of fils, UTC settlement days, Math.random for OTPs, "never edit tests").
- `claude-settings.json`: permission rules (copy to `.claude/settings.json`): allowed test commands;
  denied secrets files, force push, hard reset, `rm -rf`, `docker compose down -v`.
- `commands/`: custom slash commands (copy to `.claude/commands/`): `fix-bug`, `audit-claim`, `pre-deploy`.
- `/scripts/loadtest.py`: helper script for the capacity test.
