#!/usr/bin/env bash
# Builds the `claude-plugin` branch from a commit on main (default HEAD).
#
# The Claude directory scans the whole tree of the branch it tracks. Main also
# holds the npm package (local credential storage, lockfile, tests), and the
# directory policy holds a plugin back for that code even though the plugin
# itself only points Claude at the hosted endpoint. The branch therefore gets
# only the plugin files; main stays the single source for them.
#
# Usage: scripts/build-claude-plugin-branch.sh [--push] [<commit>]
# .github/workflows/claude-plugin-branch.yml runs it with --push after every
# change to the plugin files on main.
set -euo pipefail

BRANCH=claude-plugin
# Keep in sync with the paths filter in .github/workflows/claude-plugin-branch.yml.
PLUGIN_FILES=(.claude-plugin/plugin.json .mcp.json icon.png LICENSE skills)
BRANCH_README=.claude-plugin/README.md

push=false
if [ "${1:-}" = "--push" ]; then
  push=true
  shift
fi

cd "$(git rev-parse --show-toplevel)"
src=$(git rev-parse --verify "${1:-HEAD}^{commit}")

for path in "${PLUGIN_FILES[@]}" "$BRANCH_README"; do
  if ! git cat-file -e "$src:$path" 2>/dev/null; then
    echo "missing in $src: $path" >&2
    exit 1
  fi
done

tmp_index=$(mktemp)
trap 'rm -f "$tmp_index"' EXIT
export GIT_INDEX_FILE="$tmp_index"
git read-tree --empty
git ls-tree -r "$src" -- "${PLUGIN_FILES[@]}" | git update-index --index-info
git update-index --add --cacheinfo "100644,$(git rev-parse "$src:$BRANCH_README"),README.md"
tree=$(git write-tree)
unset GIT_INDEX_FILE

# Continue from the published branch, so the push is a fast-forward.
if $push && git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null; then
  git fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
fi
parent=$(git rev-parse -q --verify "refs/remotes/origin/$BRANCH" ||
  git rev-parse -q --verify "refs/heads/$BRANCH" || true)
if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
  echo "$BRANCH already matches $(git rev-parse --short "$src"), nothing to do"
  exit 0
fi

commit=$(git commit-tree "$tree" ${parent:+-p "$parent"} \
  -m "Build plugin from main $(git rev-parse --short "$src")")
git update-ref "refs/heads/$BRANCH" "$commit"
echo "$BRANCH -> $(git rev-parse --short "$commit")"

if $push; then
  git push origin "$commit:refs/heads/$BRANCH"
else
  echo "Publish with: git push origin $BRANCH"
fi
