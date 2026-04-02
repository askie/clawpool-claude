#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")" && pwd)

echo "=> Checking working tree status..."
if [[ -n $(git status -s) ]]; then
  echo "Error: Working tree is not clean. Please commit your changes before publishing."
  exit 1
fi

echo "=> Publishing @dhfpub/grix-claude to NPM (Public)..."
# publishConfig is set to access: public in package.json,
# but it's okay to also explicitly pass it.
"$ROOT_DIR/scripts/npm-publish.exp" npm publish --access public

echo "=> Successfully published!"
