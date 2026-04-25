#!/bin/bash
# Copyright (C) 2026 OpenMV, LLC.
#
# This software is licensed under terms that can be found in the
# LICENSE file in the root directory of this software component.
#
# Downloads the OpenMV SDK and extracts tools needed by the IDE
# into resources/tools/.

set -euo pipefail

SDK_VERSION="1.4.0"
SDK_BASE_URL="https://download.openmv.io/sdk"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TOOLS_DIR="${PROJECT_DIR}/resources/tools"

# Detect platform
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

install_sdk_tools() {
    local platform sdk_name sdk_url sdk_dir tmpfile expected actual

    platform="$(detect_platform)"
    sdk_name="openmv-sdk-${SDK_VERSION}-${platform}"
    sdk_url="${SDK_BASE_URL}/${sdk_name}.tar.xz"

    # Skip if already installed at the right version
    if [ -f "${TOOLS_DIR}/.sdk_version" ] && \
       [ "$(cat "${TOOLS_DIR}/.sdk_version")" = "${SDK_VERSION}" ]; then
        echo "SDK tools ${SDK_VERSION} already installed."
        return 0
    fi

    echo "Downloading ${sdk_name}..."
    tmpfile=$(mktemp)

    curl -fSL -o "$tmpfile" "$sdk_url" || {
        echo "Download failed: $sdk_url" >&2; return 1
    }

    # Verify checksum
    expected=$(curl -fsSL "${sdk_url}.sha256" | awk '{print $1}') || {
        echo "Could not fetch checksum from ${sdk_url}.sha256" >&2; return 1
    }
    if command -v sha256sum &>/dev/null; then
        actual=$(sha256sum "$tmpfile" | awk '{print $1}')
    else
        actual=$(shasum -a 256 "$tmpfile" | awk '{print $1}')
    fi
    if [ "$expected" != "$actual" ]; then
        echo "Checksum mismatch: expected ${expected}, got ${actual}" >&2
        return 1
    fi

    echo "Extracting SDK tools to ${TOOLS_DIR}..."
    sdk_dir=$(mktemp -d)
    tar xf "$tmpfile" -C "$sdk_dir"

    rm -rf "${TOOLS_DIR}"
    mkdir -p "${TOOLS_DIR}"
    cp "${sdk_dir}/${sdk_name}"/bin/dfu-util* "${TOOLS_DIR}/"
    cp -r "${sdk_dir}/${sdk_name}/stedgeai" "${TOOLS_DIR}/stedgeai"
    cp -r "${sdk_dir}/${sdk_name}/python" "${TOOLS_DIR}/python"
    chmod +x "${TOOLS_DIR}"/dfu-util* 2>/dev/null || true

    echo "${SDK_VERSION}" > "${TOOLS_DIR}/.sdk_version"
    rm -rf "$sdk_dir" "$tmpfile"
    echo "SDK tools ${SDK_VERSION} installed successfully."
}

install_sdk_tools
