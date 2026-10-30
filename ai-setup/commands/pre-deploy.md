---
description: Checklist before pushing to the live server
---
1. All API and Go tests pass. 2. `git status` is clean and secrets are not tracked.
3. Push to the fork. 4. On the server: `cd /opt/filspay && sudo bash ops/deploy.sh`.
5. Check `https://<domain>/healthz` returns ok and the dashboard login page loads.
