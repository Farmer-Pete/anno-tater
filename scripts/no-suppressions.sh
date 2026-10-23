#!/bin/sh
# A check switched off is a check that passes. Fails on suppression comments and on focused or skipped tests.
if grep -rnE '@ts-(ignore|nocheck|expect-error)|(oxlint|eslint)-disable|\b(test|it|describe)\.(only|skip)\(|\{ *(only|skip): *true' src test scripts --exclude=no-suppressions.sh; then
  echo "Fix the code instead of switching the check off." >&2
  exit 1
fi
