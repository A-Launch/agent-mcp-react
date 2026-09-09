#!/usr/bin/env bash
# Enables the repo's shared git hooks (.githooks/) for THIS clone.
#
# core.hooksPath is a per-clone local setting and cannot be committed, so each developer runs
# this once after cloning. It points git at the version-controlled .githooks/ directory
# (currently: a pre-push hook that keeps `main` release-only).
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
git -C "$root" config core.hooksPath .githooks
chmod +x "$root"/.githooks/* 2>/dev/null || true
echo "✓ core.hooksPath set to .githooks — shared hooks are active for this clone."
