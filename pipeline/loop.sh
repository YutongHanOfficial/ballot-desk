#!/usr/bin/env bash
# Refresh the data files, commit them, and repeat until LOOP_MINUTES have passed (0 = run once).
# GitHub's cron is unreliable for new repositories, so one long-running job keeps the data fresh.
set -uo pipefail
LOOP_MINUTES="${LOOP_MINUTES:-0}"
INTERVAL_MINUTES="${INTERVAL_MINUTES:-20}"
end=$(( $(date +%s) + LOOP_MINUTES * 60 ))

git config user.name "midterms-bot"
git config user.email "midterms-bot@users.noreply.github.com"

while :; do
  # Rebuild candidates and ratings from Wikipedia when they are more than 6 hours old.
  age=$(python3 -c "import json,datetime;d=json.load(open('data/races.json'));g=datetime.datetime.fromisoformat(d['generated']);print(int((datetime.datetime.now(datetime.timezone.utc)-g).total_seconds()))" 2>/dev/null || echo 999999)
  if [ "$age" -gt 21600 ]; then
    python3 pipeline/build_races.py --refresh || echo "::warning::race list rebuild failed; keeping the previous one"
  fi
  node pipeline/refresh.mjs || echo "::warning::refresh failed; keeping the previous data"

  git add data
  if ! git diff --cached --quiet; then
    git commit -q -m "data: refresh $(date -u +%Y-%m-%dT%H:%MZ)"
    git pull -q --rebase -X theirs origin "$(git rev-parse --abbrev-ref HEAD)" || git rebase --abort
    git push -q || echo "::warning::push failed"
  fi

  [ "$(date +%s)" -ge "$end" ] && break
  sleep $(( INTERVAL_MINUTES * 60 ))
done
