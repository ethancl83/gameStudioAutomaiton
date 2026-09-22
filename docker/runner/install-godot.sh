#!/bin/sh
set -eu
umask 077
base=https://github.com/godotengine/godot-builds/releases/download/4.3-stable
case "$(uname -m)" in
  x86_64)
    arch=x86_64
    editor_hash=fd52bb4ba8acc30ca5accd1c566d470ad7282f891ccc0995dfafabcf92bcf76280ce182bf9d80ebd885f3ed2165d01e1fc3f2928436b15498dfbd98656c2a45a ;;
  aarch64|arm64)
    arch=arm64
    editor_hash=bf559c7d24f2a7c8980d021c9e8c54baa66c5f3a1a0c1fb6fe73586eca63417fd365adf2e6c8be0b5944ab80da800fe4aa3a9024f58363f5dc3962e6127c0dc6 ;;
  *) echo 'Unsupported Linux runner architecture' >&2; exit 1 ;;
esac

download() {
  # A partial transfer is never reused as a verified archive.
  curl --fail --location --silent --show-error --retry 3 --connect-timeout 30 --max-time 1800 "$base/$1" -o "$2.partial"
  printf '%s  %s\n' "$3" "$2.partial" | sha512sum --check --status
  mv "$2.partial" "$2"
}

case "${1:-}" in
  editor)
    file="Godot_v4.3-stable_linux.$arch.zip"
    archive="/tmp/$file"
    download "$file" "$archive" "$editor_hash"
    mkdir -p /opt/godot
    unzip -q -o "$archive" "Godot_v4.3-stable_linux.$arch" -d /opt/godot
    chmod 755 "/opt/godot/Godot_v4.3-stable_linux.$arch"
    ln -s "/opt/godot/Godot_v4.3-stable_linux.$arch" /usr/local/bin/godot
    rm "$archive"
    ;;
  templates)
    data="${APPOPS_GODOT_DATA_DIR:?APPOPS_GODOT_DATA_DIR is required}"
    file=Godot_v4.3-stable_export_templates.tpz
    hash=476366caf0fd45a8f24136cf9cf1dc0bc2b96f7c82d53e5f82200b55aefd07b286d283fd6f1ce29e0de70648c5a51d3b12f96c6d4fafd4e8c4878ecda6406d6a
    mkdir -p "$data/cache" "$data/export_templates/4.3.stable"
    archive="$data/cache/$file"
    if [ ! -f "$archive" ]; then download "$file" "$archive" "$hash"; fi
    printf '%s  %s\n' "$hash" "$archive" | sha512sum --check --status
    # Only Linux templates are prepared; JDK/SSH tools do not imply other engine support.
    unzip -q -o -j "$archive" "templates/linux_debug.$arch" "templates/linux_release.$arch" templates/version.txt -d "$data/export_templates/4.3.stable"
    chmod 755 "$data/export_templates/4.3.stable/linux_debug.$arch" "$data/export_templates/4.3.stable/linux_release.$arch"
    ;;
  *) echo 'Expected editor or templates' >&2; exit 1 ;;
esac
