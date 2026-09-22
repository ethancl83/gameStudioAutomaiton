#!/bin/sh
set -eu
umask 077
sh /app/docker/runner/install-godot.sh templates
exec node --import tsx /app/apps/runner/remote-main.ts
