#!/bin/sh
set -eu
umask 077
base=https://github.com/godotengine/godot-builds/releases/download/4.7.2-stable
case "$(uname -m)" in
  x86_64)
    arch=x86_64
    editor_hash=9aa00f7a605200940bce3027a567b782f49bd8e940dd06ae9e987bd65aee1b1467edd56ed84fcdcbdd44354bf613bdbb4e5d2913e925850368e150c59ed54c65 ;;
  aarch64|arm64)
    arch=arm64
    editor_hash=dd59918da086bd49bde2f5450b5e567ff8650cbde9abbd7b8f4ca1197ff8c609baa38834666d032deafb47099078d7822279e2a0e06e5665745468f26533e7e2 ;;
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
    file="Godot_v4.7.2-stable_linux.$arch.zip"
    archive="/tmp/$file"
    download "$file" "$archive" "$editor_hash"
    mkdir -p /opt/godot
    unzip -q -o "$archive" "Godot_v4.7.2-stable_linux.$arch" -d /opt/godot
    chmod 755 "/opt/godot/Godot_v4.7.2-stable_linux.$arch"
    ln -s "/opt/godot/Godot_v4.7.2-stable_linux.$arch" /usr/local/bin/godot
    rm "$archive"
    ;;
  templates)
    data="${APPOPS_GODOT_DATA_DIR:?APPOPS_GODOT_DATA_DIR is required}"
    file=Godot_v4.7.2-stable_export_templates.tpz
    hash=ca4d71c4d7b81dfc15d1a98baa07534aa95b03fdda78a0075b06672e1648d2e5f40980c9adc28d23e1b92e732ee7bf3461997aa804af74ec2fcd7a93ccb84079
    mkdir -p "$data/cache" "$data/export_templates/4.7.2.stable"
    archive="$data/cache/$file"
    if [ ! -f "$archive" ]; then download "$file" "$archive" "$hash"; fi
    printf '%s  %s\n' "$hash" "$archive" | sha512sum --check --status
    # Only Linux templates are prepared; JDK/SSH tools do not imply other engine support.
    unzip -q -o -j "$archive" "templates/linux_debug.$arch" "templates/linux_release.$arch" templates/version.txt -d "$data/export_templates/4.7.2.stable"
    chmod 755 "$data/export_templates/4.7.2.stable/linux_debug.$arch" "$data/export_templates/4.7.2.stable/linux_release.$arch"
    ;;
  *) echo 'Expected editor or templates' >&2; exit 1 ;;
esac
