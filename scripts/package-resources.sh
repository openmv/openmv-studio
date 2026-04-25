#!/bin/bash
# Copyright (C) 2026 OpenMV, LLC.
#
# This software is licensed under terms that can be found in the
# LICENSE file in the root directory of this software component.
#
# Packages resources into tar.xz archives for upload to R2.
# Generates sha256 checksums and a manifest.json.
#
# Usage: ./scripts/package-resources.sh
#
# Requires: git, tar, xz, python3, pip (for stubs), gh (for firmware)

set -euo pipefail

# --- Configuration -----------------------------------------------------------

SDK_VERSION="1.4.0"
SDK_BASE_URL="https://download.openmv.io/sdk"
STUDIO_BASE_URL="https://download.openmv.io/studio"
BOARDS_REPO="https://github.com/openmv/openmv-boards.git"
OPENMV_REPO="https://github.com/openmv/openmv.git"
OPENMV_DOC_REPO="https://github.com/openmv/openmv-doc.git"
FIRMWARE_GH_REPO="openmv/openmv"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${PROJECT_DIR}/dist/resources"

SDK_PLATFORMS=("linux-x86_64" "darwin-arm64" "windows-x86_64")

# Firmware tag is resolved once and shared by examples, stubs, and firmware.
FW_TAG=""
FW_VERSION=""

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

    echo "Creating ${name}.tar.xz..."
    tar cJf "$archive" -C "$(dirname "$src_dir")" "$(basename "$src_dir")"
    echo "  sha256: $(sha256 "$archive")"
    echo "  size:   $(filesize "$archive")"
}

# Find latest stable firmware release and set FW_TAG / FW_VERSION.
resolve_firmware_tag() {
    if [ -n "$FW_TAG" ]; then
        return
    fi

    echo "Resolving latest stable firmware release..."
    FW_TAG=$(gh release list --repo "$FIRMWARE_GH_REPO" --limit 20 \
        --json tagName \
        --jq '[.[] | select(.tagName | startswith("v"))][0].tagName')

    if [ -z "$FW_TAG" ] || [ "$FW_TAG" = "null" ]; then
        echo "ERROR: No stable release found in $FIRMWARE_GH_REPO" >&2
        exit 1
    fi

    FW_VERSION="${FW_TAG#v}"
    echo "Firmware tag: ${FW_TAG} (version ${FW_VERSION})"
}

# Clone openmv/openmv at the firmware tag (shared by examples and stubs).
clone_openmv() {
    if [ -d "$TMPDIR/openmv" ]; then
        return
    fi
    resolve_firmware_tag
    echo "Cloning openmv @ ${FW_TAG}..."
    git clone --depth 1 --branch "$FW_TAG" "$OPENMV_REPO" "$TMPDIR/openmv"
}

# Clone openmv/openmv-doc at the firmware tag (used by stubs).
clone_openmv_doc() {
    if [ -d "$TMPDIR/openmv-doc" ]; then
        return
    fi
    resolve_firmware_tag
    echo "Cloning openmv-doc @ ${FW_TAG}..."
    git clone --depth 1 --branch "$FW_TAG" "$OPENMV_DOC_REPO" "$TMPDIR/openmv-doc"
}

# --- Package functions -------------------------------------------------------

package_boards() {
    echo "=== Packaging boards ==="
    local src="$TMPDIR/boards"

    git clone "$BOARDS_REPO" "$src"

    local version
    version=$(git -C "$src" describe --tags --abbrev=0 2>/dev/null) || true
    if [ -z "$version" ]; then
        echo "ERROR: No tags found in $BOARDS_REPO" >&2
        exit 1
    fi
    echo "Boards tag: ${version}"

    git -C "$src" checkout "$version"

    # Remove git metadata
    rm -rf "$src/.git" "$src/.gitignore"

    local archive_name="boards-${version}"
    mv "$src" "$TMPDIR/${archive_name}"
    make_archive "$archive_name" "$TMPDIR/${archive_name}"
}

package_examples() {
    echo "=== Packaging examples ==="
    clone_openmv

    local archive_name="examples-${FW_VERSION}"
    cp -r "$TMPDIR/openmv/scripts/examples" "$TMPDIR/${archive_name}"
    make_archive "$archive_name" "$TMPDIR/${archive_name}"
}

package_stubs() {
    echo "=== Packaging stubs ==="
    clone_openmv_doc

    pip install --quiet sphinx

    local archive_name="stubs-${FW_VERSION}"
    mkdir -p "$TMPDIR/${archive_name}"
    python3 "$TMPDIR/openmv-doc/genpyi.py" \
        --docs-dir "$TMPDIR/openmv-doc/docs/_sources/library/" \
        --pyi-dir "$TMPDIR/${archive_name}"
    make_archive "$archive_name" "$TMPDIR/${archive_name}"
}

package_firmware() {
    echo "=== Packaging firmware ==="
    resolve_firmware_tag

    local archive_name="firmware-${FW_VERSION}"
    mkdir -p "$TMPDIR/${archive_name}"

    echo "Downloading firmware assets from release ${FW_TAG}..."
    gh release download "$FW_TAG" \
        --repo "$FIRMWARE_GH_REPO" \
        --dir "$TMPDIR/${archive_name}" \
        --pattern "*.dfu" --pattern "*.bin" --pattern "*.zip" 2>/dev/null || true

    local count
    count=$(find "$TMPDIR/${archive_name}" -type f | wc -l | tr -d ' ')
    if [ "$count" -eq 0 ]; then
        echo "ERROR: No firmware assets found in release $FW_TAG" >&2
        return 1
    fi
    echo "  Downloaded ${count} firmware files"

    make_archive "$archive_name" "$TMPDIR/${archive_name}"
}

# --- Manifest generation -----------------------------------------------------

generate_manifest() {
    echo "=== Generating manifest.json ==="

    local manifest="${OUT_DIR}/manifest.json"

    cat > "$manifest" <<'HEADER'
{
  "schema_version": 1,
HEADER

    # Boards
    local boards_archive
    boards_archive=$(ls "${OUT_DIR}"/boards-*.tar.xz 2>/dev/null | head -1) || true
    if [ -n "$boards_archive" ]; then
        local bname bver
        bname=$(basename "$boards_archive")
        bver="${bname%.tar.xz}"
        bver="${bver#boards-}"
        cat >> "$manifest" <<EOF
  "boards": {
    "version": "${bver}",
    "url": "${STUDIO_BASE_URL}/${bname}",
    "sha256": "$(sha256 "$boards_archive")",
    "size": $(filesize "$boards_archive")
  },
EOF
    fi

    # Examples
    local examples_archive
    examples_archive=$(ls "${OUT_DIR}"/examples-*.tar.xz 2>/dev/null | head -1) || true
    if [ -n "$examples_archive" ]; then
        local ename ever
        ename=$(basename "$examples_archive")
        ever="${ename%.tar.xz}"
        ever="${ever#examples-}"
        cat >> "$manifest" <<EOF
  "examples": {
    "version": "${ever}",
    "url": "${STUDIO_BASE_URL}/${ename}",
    "sha256": "$(sha256 "$examples_archive")",
    "size": $(filesize "$examples_archive")
  },
EOF
    fi

    # Firmware
    local fw_archive
    fw_archive=$(ls "${OUT_DIR}"/firmware-*.tar.xz 2>/dev/null | head -1) || true
    if [ -n "$fw_archive" ]; then
        local fname fver
        fname=$(basename "$fw_archive")
        fver="${fname%.tar.xz}"
        fver="${fver#firmware-}"
        cat >> "$manifest" <<EOF
  "firmware": {
    "version": "${fver}",
    "url": "${STUDIO_BASE_URL}/${fname}",
    "sha256": "$(sha256 "$fw_archive")",
    "size": $(filesize "$fw_archive")
  },
EOF
    fi

    # Stubs
    local stubs_archive
    stubs_archive=$(ls "${OUT_DIR}"/stubs-*.tar.xz 2>/dev/null | head -1) || true
    if [ -n "$stubs_archive" ]; then
        local sname sver
        sname=$(basename "$stubs_archive")
        sver="${sname%.tar.xz}"
        sver="${sver#stubs-}"
        cat >> "$manifest" <<EOF
  "stubs": {
    "version": "${sver}",
    "url": "${STUDIO_BASE_URL}/${sname}",
    "sha256": "$(sha256 "$stubs_archive")",
    "size": $(filesize "$stubs_archive")
  },
EOF
    fi

    # Tools (reference existing SDK archives)
    cat >> "$manifest" <<EOF
  "tools": {
    "version": "${SDK_VERSION}",
    "platforms": {
EOF

    local first=true
    for platform in "${SDK_PLATFORMS[@]}"; do
        local sdk_name="openmv-sdk-${SDK_VERSION}-${platform}"
        local sdk_url="${SDK_BASE_URL}/${sdk_name}.tar.xz"
        local sdk_sha256_url="${sdk_url}.sha256"

        echo "  Fetching checksum for ${sdk_name}..."
        local sdk_sha256 sdk_size
        sdk_sha256=$(curl -fsSL "$sdk_sha256_url" | awk '{print $1}') || {
            echo "WARNING: Could not fetch checksum for ${sdk_name}" >&2
            continue
        }

        # Get file size via HEAD request
        sdk_size=$(curl -fsSLI "$sdk_url" | grep -i content-length | tail -1 | awk '{print $2}' | tr -d '\r')
        if [ -z "$sdk_size" ]; then
            sdk_size=0
        fi

        if [ "$first" = true ]; then
            first=false
        else
            printf ",\n" >> "$manifest"
        fi

        printf '      "%s": {\n        "url": "%s",\n        "sha256": "%s",\n        "size": %s\n      }' \
            "$platform" "$sdk_url" "$sdk_sha256" "$sdk_size" >> "$manifest"
    done

    printf '\n    }\n  }\n}\n' >> "$manifest"

    echo "Manifest written to ${manifest}"
}

# --- Main --------------------------------------------------------------------

main() {
    TMPDIR=$(mktemp -d)
    mkdir -p "$OUT_DIR"

    package_boards
    resolve_firmware_tag
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
