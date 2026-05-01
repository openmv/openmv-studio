#!/bin/bash
# Copyright (C) 2026 OpenMV, LLC.
#
# This software is licensed under terms that can be found in the
# LICENSE file in the root directory of this software component.
#
# Packages resources into tar.xz archives for upload to R2.
# Generates sha256 checksums and a manifest.json with both
# stable and development channels.
#
# Usage: ./scripts/package-resources.sh
#
# Requires: git, tar, xz, python3, pip (for stubs), gh (for firmware)

set -euo pipefail

# --- Configuration -----------------------------------------------------------

STUDIO_BASE_URL="https://download.openmv.io/studio"
BOARDS_REPO="https://github.com/openmv/openmv-boards.git"
OPENMV_REPO="https://github.com/openmv/openmv.git"
OPENMV_DOC_REPO="https://github.com/openmv/openmv-doc.git"
FIRMWARE_GH_REPO="openmv/openmv"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${PROJECT_DIR}/dist/resources"

# Stable firmware tag/version (resolved once).
STABLE_FW_TAG=""
STABLE_FW_VERSION=""

# Development version (from git describe on openmv repo).
DEV_FW_VERSION=""

# --- Helpers -----------------------------------------------------------------

TMPDIR=""
trap 'rm -rf "$TMPDIR"' EXIT

sha256() {
    if command -v sha256sum &>/dev/null; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

filesize() {
    wc -c < "$1" | tr -d ' '
}

# Create a tar.xz archive from a directory.
make_archive() {
    local name="$1"
    local src_dir="$2"
    local archive="${OUT_DIR}/${name}.tar.xz"

    echo ""
    echo "Creating ${name}.tar.xz..."
    tar cJf "$archive" -C "$(dirname "$src_dir")" "$(basename "$src_dir")"
    echo "sha256: $(sha256 "$archive")"
    echo "size:   $(filesize "$archive")"
}

# Get dev version from git describe on a shallow clone.
# Fetches tags and enough history for describe to count commits.
# Excludes non-release tags like "development".
# v4.8.1-479-gd726d833 -> v4.8.1-479
git_describe_version() {
    local dir="$1"
    git -C "$dir" fetch --tags --quiet
    git -C "$dir" fetch --deepen=1000 --quiet
    git -C "$dir" describe --tags --exclude=development | sed 's/-g[0-9a-f]*$//'
}

# --- Resolve tags/versions ---------------------------------------------------

# Find latest stable firmware release tag.
resolve_stable_fw_tag() {
    if [ -n "$STABLE_FW_TAG" ]; then
        return
    fi

    echo "Resolving latest stable firmware release..."
    STABLE_FW_TAG=$(gh release list --repo "$FIRMWARE_GH_REPO" --limit 20 \
        --json tagName \
        --jq '[.[] | select(.tagName | startswith("v"))][0].tagName')

    if [ -z "$STABLE_FW_TAG" ] || [ "$STABLE_FW_TAG" = "null" ]; then
        echo "ERROR: No stable release found in $FIRMWARE_GH_REPO" >&2
        exit 1
    fi

    STABLE_FW_VERSION="${STABLE_FW_TAG}"
    echo "Stable firmware: ${STABLE_FW_TAG}"
}

# Clone openmv repo (shallow - git_describe_version deepens as needed).
clone_openmv() {
    if [ -d "$TMPDIR/openmv" ]; then
        return
    fi
    echo "Cloning openmv..."
    git clone --depth 1 --quiet "$OPENMV_REPO" "$TMPDIR/openmv"
}

# Clone openmv-doc repo (shallow - git_describe_version deepens as needed).
clone_openmv_doc() {
    if [ -d "$TMPDIR/openmv-doc" ]; then
        return
    fi
    echo "Cloning openmv-doc..."
    git clone --depth 1 --quiet "$OPENMV_DOC_REPO" "$TMPDIR/openmv-doc"
}

# --- Package functions -------------------------------------------------------

package_boards() {
    echo "=== Packaging boards ==="
    local src="$TMPDIR/boards"

    git clone --depth 1 --quiet "$BOARDS_REPO" "$src"
    git -C "$src" fetch --tags --quiet

    # Stable: checkout latest tag
    local stable_version
    stable_version=$(git -C "$src" tag --sort=-v:refname | head -1) || true
    if [ -z "$stable_version" ]; then
        echo "ERROR: No tags found in $BOARDS_REPO" >&2
        exit 1
    fi
    echo "Boards stable: ${stable_version}"

    # Package HEAD as dev first (before checking out the tag)
    local dev_version
    dev_version=$(git_describe_version "$src")
    echo "Boards development: ${dev_version}"
    cp -r "$src" "$TMPDIR/boards-dev"
    rm -rf "$TMPDIR/boards-dev/.git" "$TMPDIR/boards-dev/.gitignore"
    make_archive "boards-dev" "$TMPDIR/boards-dev"
    echo "$dev_version" > "${OUT_DIR}/boards-dev.version"

    # Now checkout stable tag and package
    git -C "$src" fetch --depth 1 origin tag "$stable_version" --quiet
    git -C "$src" checkout "$stable_version" --quiet
    rm -rf "$src/.git" "$src/.gitignore"
    make_archive "boards" "$src"
    echo "$stable_version" > "${OUT_DIR}/boards.version"
}

package_examples() {
    echo ""
    echo "=== Packaging examples ==="
    clone_openmv
    resolve_stable_fw_tag

    # Development: package from HEAD first (git_describe_version deepens as needed)
    DEV_FW_VERSION=$(git_describe_version "$TMPDIR/openmv")
    echo "Development firmware version: ${DEV_FW_VERSION}"
    cp -r "$TMPDIR/openmv/scripts/examples" "$TMPDIR/examples-dev"
    make_archive "examples-dev" "$TMPDIR/examples-dev"
    echo "$DEV_FW_VERSION" > "${OUT_DIR}/examples-dev.version"
    rm -rf "$TMPDIR/examples-dev"

    # Stable: fetch and checkout stable tag
    git -C "$TMPDIR/openmv" fetch --depth 1 origin tag "$STABLE_FW_TAG" --quiet
    git -C "$TMPDIR/openmv" checkout "$STABLE_FW_TAG" --quiet
    cp -r "$TMPDIR/openmv/scripts/examples" "$TMPDIR/examples"
    make_archive "examples" "$TMPDIR/examples"
    echo "$STABLE_FW_VERSION" > "${OUT_DIR}/examples.version"
    rm -rf "$TMPDIR/examples"
}

package_stubs() {
    echo ""
    echo "=== Packaging stubs ==="
    clone_openmv_doc
    resolve_stable_fw_tag

    pip install --quiet sphinx &>/dev/null

    # Development: package from HEAD first (git_describe_version deepens as needed)
    local dev_version
    dev_version=$(git_describe_version "$TMPDIR/openmv-doc")
    echo "Stubs development: ${dev_version}"
    mkdir -p "$TMPDIR/stubs-dev"
    python3 "$TMPDIR/openmv-doc/genpyi.py" \
        --docs-dir "$TMPDIR/openmv-doc/docs/_sources/library/" \
        --pyi-dir "$TMPDIR/stubs-dev"
    make_archive "stubs-dev" "$TMPDIR/stubs-dev"
    echo "$dev_version" > "${OUT_DIR}/stubs-dev.version"
    rm -rf "$TMPDIR/stubs-dev"

    # Stable: fetch and checkout stable tag
    git -C "$TMPDIR/openmv-doc" fetch --depth 1 origin tag "$STABLE_FW_TAG" --quiet
    git -C "$TMPDIR/openmv-doc" checkout "$STABLE_FW_TAG" --quiet
    mkdir -p "$TMPDIR/stubs"
    python3 "$TMPDIR/openmv-doc/genpyi.py" \
        --docs-dir "$TMPDIR/openmv-doc/docs/_sources/library/" \
        --pyi-dir "$TMPDIR/stubs"
    make_archive "stubs" "$TMPDIR/stubs"
    echo "$STABLE_FW_VERSION" > "${OUT_DIR}/stubs.version"
    rm -rf "$TMPDIR/stubs"
}

package_firmware() {
    echo ""
    echo "=== Packaging firmware ==="
    resolve_stable_fw_tag

    # Stable firmware
    mkdir -p "$TMPDIR/firmware"

    gh release download "$STABLE_FW_TAG" \
        --repo "$FIRMWARE_GH_REPO" \
        --dir "$TMPDIR/firmware" \
        --pattern "*.zip" &>/dev/null || true

    for zip in "$TMPDIR/firmware"/*.zip; do
        [ -f "$zip" ] || continue
        unzip -q -o "$zip" -d "$TMPDIR/firmware"
        rm "$zip"
    done

    local count
    count=$(find "$TMPDIR/firmware" -type f | wc -l | tr -d ' ')
    if [ "$count" -eq 0 ]; then
        echo "ERROR: No firmware assets found in release $STABLE_FW_TAG" >&2
        return 1
    fi
    echo "Stable: ${count} firmware files"
    make_archive "firmware" "$TMPDIR/firmware"
    echo "$STABLE_FW_VERSION" > "${OUT_DIR}/firmware.version"

    # Development firmware
    # DEV_FW_VERSION was set by package_examples (from git describe on openmv)
    mkdir -p "$TMPDIR/firmware-dev"

    gh release download "development" \
        --repo "$FIRMWARE_GH_REPO" \
        --dir "$TMPDIR/firmware-dev" \
        --pattern "*.zip" &>/dev/null || true

    for zip in "$TMPDIR/firmware-dev"/*.zip; do
        [ -f "$zip" ] || continue
        unzip -q -o "$zip" -d "$TMPDIR/firmware-dev"
        rm "$zip"
    done

    count=$(find "$TMPDIR/firmware-dev" -type f | wc -l | tr -d ' ')
    if [ "$count" -eq 0 ]; then
        echo "WARNING: No dev firmware assets found" >&2
    else
        echo "Development: ${count} firmware files"
    fi
    make_archive "firmware-dev" "$TMPDIR/firmware-dev"
    echo "$DEV_FW_VERSION" > "${OUT_DIR}/firmware-dev.version"
}

# --- Manifest generation -----------------------------------------------------

# Emit a JSON entry for a channeled resource (boards, examples, firmware, stubs).
# Looks for archives matching {name}-*.tar.xz in OUT_DIR.
emit_resource_entry() {
    local name="$1"

    local stable_archive=""
    local dev_archive=""

    # Both channels use fixed filenames to avoid accumulating old archives
    if [ -f "${OUT_DIR}/${name}-dev.tar.xz" ]; then
        dev_archive="${OUT_DIR}/${name}-dev.tar.xz"
    fi
    if [ -f "${OUT_DIR}/${name}.tar.xz" ]; then
        stable_archive="${OUT_DIR}/${name}.tar.xz"
    fi

    local first=true

    printf '  "%s": {\n' "$name"

    if [ -n "$stable_archive" ]; then
        local sver
        sver=$(cat "${OUT_DIR}/${name}.version")
        printf '    "stable": {\n'
        printf '      "version": "%s",\n' "$sver"
        printf '      "url": "%s/%s.tar.xz",\n' "$STUDIO_BASE_URL" "$name"
        printf '      "sha256": "%s",\n' "$(sha256 "$stable_archive")"
        printf '      "size": %s\n' "$(filesize "$stable_archive")"
        printf '    }'
        first=false
    fi

    if [ -n "$dev_archive" ]; then
        if [ "$first" = false ]; then
            printf ',\n'
        fi
        local dver
        dver=$(cat "${OUT_DIR}/${name}-dev.version")
        printf '    "development": {\n'
        printf '      "version": "%s",\n' "$dver"
        printf '      "url": "%s/%s-dev.tar.xz",\n' "$STUDIO_BASE_URL" "$name"
        printf '      "sha256": "%s",\n' "$(sha256 "$dev_archive")"
        printf '      "size": %s\n' "$(filesize "$dev_archive")"
        printf '    }'
    fi

    printf '\n  }'
}

generate_manifest() {
    echo ""
    echo "=== Generating manifest.json ==="

    local manifest="${OUT_DIR}/manifest.json"

    {
        printf '{\n  "schema_version": 1,\n'

        emit_resource_entry "boards"
        printf ',\n'

        emit_resource_entry "examples"
        printf ',\n'

        emit_resource_entry "firmware"
        printf ',\n'

        emit_resource_entry "stubs"
        printf ',\n'

        # Tools: openmv-sdk publishes tools.json describing the latest tools
        # release (version + per-platform url/sha256/size). We splice it in
        # verbatim under "tools".
        local tools_json
        tools_json=$(curl -fsSL "${STUDIO_BASE_URL}/tools.json") || {
            echo "ERROR: Could not fetch ${STUDIO_BASE_URL}/tools.json" >&2
            exit 1
        }
        printf '  "tools": '
        printf '%s' "$tools_json" | python3 -c '
import json, sys
print(json.dumps(json.load(sys.stdin), indent=2).replace("\n", "\n  "))
'

        printf '\n}\n'
    } > "$manifest"

    echo "Manifest written to ${manifest}"
}

# --- Main --------------------------------------------------------------------

main() {
    TMPDIR=$(mktemp -d)
    mkdir -p "$OUT_DIR"

    resolve_stable_fw_tag
    package_boards
    package_examples
    package_stubs
    package_firmware
    generate_manifest

    echo ""
    echo "=== Done ==="
    echo "Archives in: ${OUT_DIR}"
    ls -lh "${OUT_DIR}"
}

main
