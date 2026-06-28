#!/usr/bin/env bash
#
# TawTerminal release script.
#
#   ./release.sh            # bump patch  (0.2.2 -> 0.2.3), build, publish
#   ./release.sh minor      # bump minor  (0.2.2 -> 0.3.0)
#   ./release.sh major      # bump major  (0.2.2 -> 1.0.0)
#   ./release.sh 0.5.0      # set an explicit version
#   ./release.sh --no-bump  # re-release the current version as-is
#
# What it does, in order:
#   1. Bump the version in package.json
#   2. Build a signed + notarized DMG/zip  (npm run dist)
#   3. Commit the version bump, tag it, push
#   4. Create a GitHub Release and upload the artifacts (dmg, zip, blockmaps, latest-mac.yml)
#
# After it finishes: replace the DMG on Gumroad with the new one (link printed at the end).
#
# Apple notarization creds are read from `.env.release` (gitignored). Copy
# `.env.release.example` -> `.env.release` and fill it in once.

set -euo pipefail

cd "$(dirname "$0")"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
die()  { printf "\033[31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

# --- 0. Pre-flight -----------------------------------------------------------

[ -f .env.release ] || die "Missing .env.release — copy .env.release.example and fill in your Apple creds."
set -a; . ./.env.release; set +a

: "${APPLE_ID:?APPLE_ID not set in .env.release}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD not set in .env.release}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set in .env.release}"

command -v gh >/dev/null   || die "gh CLI not installed (brew install gh)."
gh auth status >/dev/null 2>&1 || die "gh not logged in (run: gh auth login)."

# Don't release on top of uncommitted work (other than package files we bump).
if [ -n "$(git status --porcelain -- ':!package.json' ':!package-lock.json')" ]; then
  die "Working tree has uncommitted changes. Commit or stash them first."
fi

# --- 1. Version bump ---------------------------------------------------------

ARG="${1:-patch}"
if [ "$ARG" = "--no-bump" ]; then
  VER="$(node -p "require('./package.json').version")"
  bold "Re-releasing current version v$VER"
else
  npm version "$ARG" --no-git-tag-version >/dev/null
  VER="$(node -p "require('./package.json').version")"
  bold "Bumped version -> v$VER"
fi

TAG="v$VER"
DMG="dist/TawTerminal-${VER}-arm64.dmg"
ZIP="dist/TawTerminal-${VER}-arm64-mac.zip"

# Abort if this tag already exists on the remote (avoid clobbering a release).
if git ls-remote --tags origin | grep -q "refs/tags/${TAG}$"; then
  die "Tag ${TAG} already exists on origin. Bump to a new version."
fi

# --- 2. Build (sign + notarize) ----------------------------------------------

bold "Building signed + notarized build (this can take a few minutes)…"
npm run dist

[ -f "$DMG" ] || die "Expected DMG not found: $DMG"
[ -f "$ZIP" ] || die "Expected zip not found: $ZIP"

# Sanity: confirm Gatekeeper accepts the freshly built app.
APP="dist/mac-arm64/TawTerminal.app"
if [ -d "$APP" ]; then
  spctl -a -vvv -t install "$APP" >/dev/null 2>&1 \
    && bold "✓ Gatekeeper: notarized & accepted" \
    || die "Gatekeeper rejected the build — check signing/notarization."
fi

# --- 3. Commit, tag, push ----------------------------------------------------

if [ "$ARG" != "--no-bump" ]; then
  git add package.json package-lock.json
  git commit -m "release: $TAG" >/dev/null
fi
git tag -a "$TAG" -m "TawTerminal $TAG"
bold "Pushing commit + tag…"
git push origin HEAD
git push origin "$TAG"

# --- 4. GitHub Release -------------------------------------------------------

# Collect every artifact for this version (dmg, zip, their .blockmaps, feed yml).
ASSETS=()
for f in "$DMG" "$DMG.blockmap" "$ZIP" "$ZIP.blockmap" dist/latest-mac.yml; do
  [ -f "$f" ] && ASSETS+=("$f")
done

bold "Creating GitHub Release $TAG with ${#ASSETS[@]} assets…"
gh release create "$TAG" "${ASSETS[@]}" \
  --title "TawTerminal $TAG" \
  --generate-notes

# --- Done --------------------------------------------------------------------

echo
bold "✅ Released $TAG"
echo "   GitHub:  https://github.com/tawgroup/taw-terminal/releases/tag/$TAG"
echo
bold "👉 Last manual step: update the file on Gumroad"
echo "   1. https://gumroad.com/products  ->  TawTerminal  ->  Content tab"
echo "   2. Remove the old DMG, upload:  $DMG"
echo "   3. Save changes"
echo
echo "   (New downloaders get it from Gumroad; existing users get the in-app"
echo "    'Update' button which pulls this GitHub release via curl.)"
