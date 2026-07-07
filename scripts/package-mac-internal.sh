#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PATH="${1:-$ROOT_DIR/desktop/src-tauri/target/release/bundle/macos/OpController.app}"
DMG_PATH="${2:-$ROOT_DIR/desktop/src-tauri/target/release/bundle/dmg/OpController_0.1.0_aarch64_internal.dmg}"
STAGING_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

if [[ ! -d "$APP_PATH" ]]; then
  echo "App bundle not found: $APP_PATH" >&2
  exit 1
fi

mkdir -p "$(dirname "$DMG_PATH")"

echo "Signing app bundle with local ad-hoc identity..."
codesign --force --deep --sign - --timestamp=none "$APP_PATH"

echo "Verifying app bundle signature..."
codesign --verify --deep --strict --verbose=4 "$APP_PATH"

echo "Preparing DMG staging directory..."
ditto "$APP_PATH" "$STAGING_DIR/OpController.app"
ln -s /Applications "$STAGING_DIR/Applications"

echo "Creating internal DMG..."
hdiutil create \
  -volname "OpController" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

echo "Verifying DMG checksum..."
hdiutil verify "$DMG_PATH"

echo "Internal DMG created:"
echo "$DMG_PATH"
