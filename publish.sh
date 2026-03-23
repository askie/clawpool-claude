#!/usr/bin/env bash
set -euo pipefail

OPEN_CMD=${OPEN_CMD:-open}

run_publish() {
  local publish_log
  publish_log=$(mktemp)
  trap 'rm -f "$publish_log"' RETURN

  set +e
  npm publish --access public 2>&1 | tee "$publish_log"
  local publish_status=${PIPESTATUS[0]}
  set -e

  if [[ $publish_status -eq 0 ]]; then
    return 0
  fi

  if grep -q "npm error code EOTP" "$publish_log"; then
    local auth_url
    auth_url=$(sed -n 's/^npm error   \(https:\/\/www\.npmjs\.com\/auth\/cli\/.*\)$/\1/p' "$publish_log" | tail -n 1)
    if [[ -n "$auth_url" ]]; then
      echo "=> Opening npm web auth page..."
      "$OPEN_CMD" "$auth_url"
      echo "=> Complete the browser auth, then rerun ./publish.sh"
      return 2
    fi
  fi

  return "$publish_status"
}

echo "=> Checking working tree status..."
if [[ -n $(git status -s) ]]; then
  echo "Error: Working tree is not clean. Please commit your changes before publishing."
  exit 1
fi

echo "=> Publishing @dhfpub/clawpool-claude to NPM (Public)..."
# publishConfig is set to access: public in package.json,
# but it's okay to also explicitly pass it.
run_publish

echo "=> Successfully published!"
