#!/bin/bash
# Copyright (C) 2026 OpenMV, LLC.
#
# This software is licensed under terms that can be found in the
# LICENSE file in the root directory of this software component.
#
# Fetches all resources needed to build OpenMV Studio from source:
#   - Examples from the openmv repo
#   - Python type stubs generated from openmv-doc
#   - SDK tools (dfu-util, stedgeai, python)

set -euo pipefail

SDK_VERSION="1.4.0"
SDK_BASE_URL="https://download.openmv.io/sdk"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TOOLS_DIR="${PROJECT_DIR}/resources/tools"
EXAMPLES_DIR="${PROJECT_DIR}/resources/examples"
STUBS_DIR="${PROJECT_DIR}/resources/stubs"

detect_platform() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"
    case "${os}-${arch}" in
        Linux-x86_64)   echo "linux-x86_64" ;;
        Darwin-arm64)   echo "darwin-arm64" ;;
        MINGW*|MSYS*)   echo "windows-x86_64" ;;
        *)              echo "Unsupported platform: ${os}-${arch}" >&2; exit 1 ;;
    esac
}

TMPDIR=""
trap 'rm -rf "$TMPDIR"' EXIT

setup() {
    TMPDIR=$(mktemp -d)
    local tmpdir="$TMPDIR"

    # Examples
    if [ -d "${EXAMPLES_DIR}" ]; then
        echo "Examples already installed."
    else
        echo "Installing examples..."
        git clone --depth 1 https://github.com/openmv/openmv.git "$tmpdir/openmv"
        cp -r "$tmpdir/openmv/scripts/examples" "${EXAMPLES_DIR}"
        echo "Examples installed successfully."
    fi

    # Stubs
    if [ -d "${STUBS_DIR}" ]; then
        echo "Stubs already installed."
    else
        echo "Installing stubs..."
        if [ ! -d "$tmpdir/openmv" ]; then
            git clone --depth 1 https://github.com/openmv/openmv.git "$tmpdir/openmv"
        fi
        git clone --depth 1 https://github.com/openmv/openmv-doc.git "$tmpdir/openmv-doc"
        pip install --quiet sphinx
        python3 "$tmpdir/openmv/tools/gen_api.py" \
            --docs-dir "$tmpdir/openmv-doc/docs/_sources/library/" \
            --pyi-dir "${STUBS_DIR}"
        echo "Stubs installed successfully."
    fi

    # SDK tools
    if [ -f "${TOOLS_DIR}/.sdk_version" ] && \
       [ "$(cat "${TOOLS_DIR}/.sdk_version")" = "${SDK_VERSION}" ]; then
        echo "SDK tools ${SDK_VERSION} already installed."
    else
        local platform sdk_name sdk_url sdk_file expected actual
        platform="$(detect_platform)"
        sdk_name="openmv-sdk-${SDK_VERSION}-${platform}"
        sdk_url="${SDK_BASE_URL}/${sdk_name}.tar.xz"
        sdk_file="$tmpdir/sdk.tar.xz"

        echo "Downloading ${sdk_name}..."
        curl -fSL -o "$sdk_file" "$sdk_url" || {
            echo "Download failed: $sdk_url" >&2; return 1
        }

        # Verify checksum
        expected=$(curl -fsSL "${sdk_url}.sha256" | awk '{print $1}') || {
            echo "Could not fetch checksum from ${sdk_url}.sha256" >&2; return 1
        }
        if command -v sha256sum &>/dev/null; then
            actual=$(sha256sum "$sdk_file" | awk '{print $1}')
        else
            actual=$(shasum -a 256 "$sdk_file" | awk '{print $1}')
        fi
        if [ "$expected" != "$actual" ]; then
            echo "Checksum mismatch: expected ${expected}, got ${actual}" >&2
            return 1
        fi

        echo "Extracting SDK tools to ${TOOLS_DIR}..."
        tar xf "$sdk_file" -C "$tmpdir"

        rm -rf "${TOOLS_DIR}"
        mkdir -p "${TOOLS_DIR}"
        cp "$tmpdir/${sdk_name}"/bin/dfu-util* "${TOOLS_DIR}/"
        cp -r "$tmpdir/${sdk_name}/stedgeai" "${TOOLS_DIR}/stedgeai"
        cp -r "$tmpdir/${sdk_name}/python" "${TOOLS_DIR}/python"
        chmod +x "${TOOLS_DIR}"/dfu-util* 2>/dev/null || true

        echo "${SDK_VERSION}" > "${TOOLS_DIR}/.sdk_version"
        echo "SDK tools ${SDK_VERSION} installed successfully."
    fi
}

setup
