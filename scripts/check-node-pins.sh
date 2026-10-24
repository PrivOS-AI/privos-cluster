#!/usr/bin/env bash
# CVE-2026-111497 (Brotli RCE): fail when a tracked Dockerfile, .nvmrc, .node-version, package.json engines.node
# or a workflow node-version names an unpatched or floating Node, or a FROM image has no sha256 digest.
# Versions are compared with sort -V (22.23.10 > 22.23.4), never as strings.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

declare -A MIN=([22]=22.23.4 [24]=24.22.1 [26]=26.12.1)
fail=0
bad() { echo "check-node-pins: $*" >&2; fail=1; }

# $1 = exact X.Y.Z version, $2 = where it was found
check_version() {
  local v=$1 min=${MIN[${1%%.*}]:-}
  if [[ ! $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then bad "$2: '$v' is not an exact X.Y.Z Node version"; return; fi
  if [[ -z $min ]]; then bad "$2: Node $v is not on a patched line (22, 24, 26)"; return; fi
  [[ $(printf '%s\n%s\n' "$min" "$v" | sort -V | head -1) == "$min" ]] || bad "$2: Node $v is below $min"
}

while IFS= read -r f; do
  stages=" "
  while IFS= read -r line; do
    read -r _ image rest <<<"$(sed -E 's/--platform=[^ ]+ //' <<<"$line")"
    alias=$(grep -oiE ' as +[^ ]+' <<<" $rest" | awk '{print tolower($2)}' || true)
    if [[ $stages == *" ${image,,} "* || $image == scratch ]]; then :
    elif [[ $image == *'$'* ]]; then
      # A build-arg base (e.g. a locally built, already pinned image) is accepted only when this file runs the guard.
      grep -q 'CVE-2026-111497 minimum' "$f" || bad "$f: FROM $image uses a build arg and the file has no Node guard"
    elif [[ ! $image =~ @sha256:[0-9a-f]{64}$ ]]; then bad "$f: FROM $image has no @sha256 digest"
    fi
    if [[ $image =~ ^(docker\.io/)?(library/)?node:([^@]+) ]]; then
      check_version "${BASH_REMATCH[3]%%-*}" "$f: FROM $image"
    fi
    [[ -n $alias ]] && stages+="$alias "
  done < <(grep -iE '^[[:space:]]*FROM[[:space:]]' "$f")
done < <(git ls-files | grep -E '(^|/)([Dd]ockerfile[^/]*|[^/]+\.[Dd]ockerfile)$')

for f in $(git ls-files | grep -E '(^|/)\.(nvmrc|node-version)$'); do
  check_version "$(tr -d ' v\r\n' <"$f")" "$f"
done

# Root package.json only: published libraries inside the repo keep their own wider engines range.
if [[ -f package.json ]]; then
  engine=$(node -e 'const e=(require("./package.json").engines||{}).node;if(e)console.log(e)')
  [[ -z $engine ]] || check_version "$(grep -oE '[0-9]+(\.[0-9]+){0,2}' <<<"$engine" | head -1)" "package.json: engines.node '$engine'"
fi

while IFS=: read -r f _ value; do
  value=${value#*node*:}
  for v in $(tr -d "[]'\"," <<<"$value"); do
    [[ $v == '${{'* || $v == '#'* ]] && break
    check_version "$v" "$f: node-version $v"
  done
done < <(git ls-files '.github/workflows/*.yml' '.github/workflows/*.yaml' | xargs -r grep -HnE '^[[:space:]]*-?[[:space:]]*node(-version)?:[[:space:]]*[^ ]' | grep -vE 'node(-version)?:[[:space:]]*\$\{\{' || true)

[[ $fail == 0 ]] && echo "check-node-pins: OK"
exit $fail
