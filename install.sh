#!/bin/sh
# Installs Anno Tater: the Claude Code skill, the helper that carries replies, and the browser
# extension for Chrome, Zen, and Firefox Developer Edition.
#
# From a clone:  ./install.sh                 (builds first; needs Node 26 and npm)
# Without one:   curl -fsSL https://github.com/Farmer-Pete/anno-tater/releases/latest/download/install.sh | sh
#                (downloads that release; needs Node 20+)
set -eu

REPO=Farmer-Pete/anno-tater
# The release to download. A release's own copy of this script names its version here, so it
# installs the files it was published with.
TAG=latest
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
  XPI=$SRC/dist/anno-tater.xpi
else
  say "Downloading release $TAG"
  SRC=$(mktemp -d)
  trap 'rm -rf "$SRC"' EXIT
  if [ "$TAG" = latest ]; then base=https://github.com/$REPO/releases/latest/download; else base=https://github.com/$REPO/releases/download/$TAG; fi
  base=${ANNO_TATER_RELEASE_URL:-$base} # for testing against a copy of a release
  FILES="anno-tater-skill.tar.gz anno-tater-chrome.zip anno-tater.xpi"
  for f in SHA256SUMS $FILES; do curl -fsSL -o "$SRC/$f" "$base/$f" || die "couldn't download $f from $base"; done
  # SHA256SUMS comes from the same release page as the files, so on its own it can't catch a
  # swapped release. With the GitHub CLI logged in, check that this repo's Release workflow built
  # it; the checksums below then vouch for every other file.
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && gh attestation verify --help >/dev/null 2>&1; then
    # A release's own copy also pins the tag it was published for.
    set -- --repo "$REPO" --signer-workflow "$REPO/.github/workflows/release.yml"
    if [ "$TAG" != latest ]; then set -- "$@" --source-ref "refs/tags/$TAG"; fi
    gh attestation verify "$SRC/SHA256SUMS" "$@" >/dev/null 2>&1 \
      || die "SHA256SUMS wasn't built by $REPO's Release workflow for $TAG; nothing was installed"
    echo "  Checked: $REPO's Release workflow built these files."
  else
    echo "  Log in to the GitHub CLI (gh auth login) to also check where these files were built."
  fi
  # Every file must match the release's SHA256SUMS before anything is unpacked or run.
  sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum -c -; else shasum -a 256 -c -; fi; }
  for f in $FILES; do
    sum=$(grep -E "^[0-9a-f]{64}  $f\$" "$SRC/SHA256SUMS" || true)
    [ -n "$sum" ] || die "SHA256SUMS doesn't list $f; nothing was installed"
    (cd "$SRC" && printf '%s\n' "$sum" | sha256 >/dev/null 2>&1) || die "$f doesn't match the release's SHA256SUMS; nothing was installed"
  done
  tar -xzf "$SRC/anno-tater-skill.tar.gz" -C "$SRC"
  mkdir -p "$SRC/chrome" && (cd "$SRC/chrome" && unzip -q ../anno-tater-chrome.zip)
  SKILL_SRC=$SRC/skill
  CHROME_SRC=$SRC/chrome
  XPI=$SRC/anno-tater.xpi
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
has_app() { # macOS app name or Linux binary
  if [ "$(uname)" = Darwin ]; then [ -d "/Applications/$1.app" ]; else command -v "$2" >/dev/null 2>&1; fi
}

# Zen and Firefox Developer Edition run the unsigned add-on once signature checks are off.
# Regular Firefox can't, so it isn't offered.
for gecko in "Zen:app.zen-browser.zen:zen" "Firefox Developer Edition:org.mozilla.firefoxdeveloperedition:firefox-developer-edition"; do
  name=${gecko%%:*}; rest=${gecko#*:}; bundle=${rest%%:*}; bin=${rest#*:}
  has_app "$name" "$bin" || continue
  say "$name"
  echo "  $name only installs unsigned add-ons with signature checks off:"
  echo "    1. In $name, open about:config and set xpinstall.signatures.required to false."
  printf '    2. Press Enter here, and %s will ask to add Anno Tater. Click Add. ' "$name"
  read -r _ </dev/tty || true
  open_in "$bundle" "$bin" "$XPI"
done

if has_profile "Library/Application Support/Google/Chrome" ".config/google-chrome"; then
  say "Chrome"
  # Chrome runs this folder's code on every site the person allows, so only they can change it.
  mkdir -p "$DATA"
  chmod 700 "$DATA"
  rm -rf "$DATA/chrome"
  cp -R "$CHROME_SRC" "$DATA/chrome"
  chmod -R go-rwx "$DATA/chrome"
  # Mode bits don't cover macOS access-control entries (inherited from a parent folder, say).
  if [ "$(uname)" = Darwin ]; then chmod -N "$DATA" && chmod -R -N "$DATA/chrome"; fi
  echo "  Chrome only installs extensions from outside its store through Developer mode:"
  echo "    1. Open chrome://extensions and turn on Developer mode (top right)."
  echo "    2. Click Load unpacked and choose: $DATA/chrome"
  echo "  Already loaded from that folder? Click its reload button instead."
fi

say "Done"
echo "  Ask Claude to annotate a page, for example: \"Review this design doc and mark it up with tater.\""
echo "  The first time Anno Tater shows notes on a site, click its toolbar icon and Allow that site."
