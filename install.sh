#!/bin/sh
# Installs Anno Tater: the Claude Code skill, the helper that carries replies, and the browser
# extensions for Chrome, Firefox, and Zen.
#
# From a clone:  ./install.sh                 (builds first; needs Node 26 and npm)
# Without one:   curl -fsSL https://raw.githubusercontent.com/Farmer-Pete/anno-tater/main/install.sh | sh
#                (downloads the latest release; needs Node 20+)
set -eu

REPO=Farmer-Pete/anno-tater
DATA=${ANNO_TATER_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/anno-tater}
SKILL_DIR=${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/tater

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die() { printf 'anno-tater: %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js 20 or newer is required: https://nodejs.org"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node.js 20 or newer is required (found $(node -v))"

# ---------- get the built pieces ----------
if [ -f package.json ] && grep -q '"name": "anno-tater"' package.json; then
  say "Building from this clone"
  npm ci --silent
  npm run --silent build
  SRC=$(pwd)
  SKILL_SRC=$SRC/skill
  CHROME_SRC=$SRC/dist/chrome
  FIREFOX_SRC=$SRC/dist/firefox
  XPI=$SRC/dist/anno-tater-$(node -p 'require("./package.json").version').xpi # written by npm run sign:firefox
  [ -f "$XPI" ] || XPI=
else
  say "Downloading the latest release"
  SRC=$(mktemp -d)
  trap 'rm -rf "$SRC"' EXIT
  base=https://github.com/$REPO/releases/latest/download
  curl -fsSL "$base/anno-tater-skill.tar.gz" | tar -xz -C "$SRC"
  curl -fsSL -o "$SRC/chrome.zip" "$base/anno-tater-chrome.zip"
  mkdir -p "$SRC/chrome" && (cd "$SRC/chrome" && unzip -q ../chrome.zip)
  curl -fsSL -o "$SRC/anno-tater.xpi" "$base/anno-tater.xpi" || true
  SKILL_SRC=$SRC/skill
  CHROME_SRC=$SRC/chrome
  FIREFOX_SRC=
  XPI=$SRC/anno-tater.xpi
  [ -s "$XPI" ] || XPI=
fi

# ---------- the Claude Code skill ----------
say "Installing the tater skill"
rm -rf "$SKILL_DIR"
mkdir -p "$(dirname "$SKILL_DIR")"
cp -R "$SKILL_SRC" "$SKILL_DIR"
echo "  $SKILL_DIR"

# ---------- the helper (replies from the page) ----------
say "Registering the helper with your browsers"
node "$SKILL_DIR/bin/tater.mjs" install | sed 's/^/  /'

# ---------- browsers ----------
open_in() { # bundle id (macOS) or binary (Linux), then the target
  if [ "$(uname)" = Darwin ]; then open -b "$1" "$3"; else "$2" "$3" >/dev/null 2>&1 & fi
}
has_profile() { [ -d "$HOME/$1" ] || [ -d "$HOME/$2" ]; }

for gecko in "Firefox:org.mozilla.firefox:firefox:Library/Application Support/Firefox:.mozilla/firefox" \
             "Zen:app.zen-browser.zen:zen:Library/Application Support/zen:.zen"; do
  name=${gecko%%:*}; rest=${gecko#*:}; bundle=${rest%%:*}; rest=${rest#*:}; bin=${rest%%:*}; rest=${rest#*:}
  mac=${rest%%:*}; linux=${rest#*:}
  has_profile "$mac" "$linux" || continue
  say "$name"
  if [ -n "$XPI" ]; then
    open_in "$bundle" "$bin" "$XPI"
    echo "  $name is asking to add Anno Tater. Click Add."
  elif [ -n "$FIREFOX_SRC" ]; then
    echo "  No signed build yet, so $name can only load it until it restarts:"
    echo "  about:debugging > This Firefox > Load Temporary Add-on > $FIREFOX_SRC/manifest.json"
  else
    echo "  This release has no signed Firefox build. Skipping $name."
  fi
done

if has_profile "Library/Application Support/Google/Chrome" ".config/google-chrome"; then
  say "Chrome"
  mkdir -p "$DATA"
  rm -rf "$DATA/chrome"
  cp -R "$CHROME_SRC" "$DATA/chrome"
  echo "  Chrome only installs extensions from outside its store through Developer mode:"
  echo "    1. Open chrome://extensions and turn on Developer mode (top right)."
  echo "    2. Click Load unpacked and choose: $DATA/chrome"
  echo "  Already loaded from that folder? Click its reload button instead."
fi

say "Done"
echo "  Ask Claude to annotate a page, for example: \"Review this design doc and mark it up with tater.\""
echo "  The first time Anno Tater shows notes on a site, click its toolbar icon and Allow that site."
