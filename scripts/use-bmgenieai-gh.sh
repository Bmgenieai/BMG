#!/usr/bin/env bash
# Switch GitHub CLI to Bmgenieai for this project's pushes (Vercel-safe).
# Other projects: run  gh auth switch --user AdullahQureshi
set -euo pipefail
if ! gh auth status -h github.com 2>/dev/null | grep -q 'Bmgenieai'; then
  echo "Bmgenieai is not logged into gh yet. Run once:"
  echo "  gh auth login"
  echo "  (GitHub.com → HTTPS → Login as Bmgenieai)"
  exit 1
fi
gh auth switch --user Bmgenieai
gh auth status
echo
echo "OK — commits/pushes from frontend/ and backend/ will use Bmgenieai credentials."
echo "When done with BmGenie, switch back:"
echo "  gh auth switch --user AdullahQureshi"
