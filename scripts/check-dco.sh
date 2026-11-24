#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'Usage: bash scripts/check-dco.sh <base> <head>\n' >&2
  exit 2
fi

base=$(git rev-parse --verify --end-of-options "$1^{commit}")
head=$(git rev-parse --verify --end-of-options "$2^{commit}")
commits=$(git rev-list "$base..$head")
missing=0

for commit in $commits; do
  author=$(git show -s --format='%an <%ae>' "$commit")
  signoffs=$(git show -s --format='%(trailers:key=Signed-off-by,valueonly,unfold)' "$commit")
  if ! grep -Fxiq -- "$author" <<< "$signoffs"; then
    printf '%s is missing its author sign-off. Use git commit -s for new commits.\n' "$commit" >&2
    missing=1
  fi
done

exit "$missing"
