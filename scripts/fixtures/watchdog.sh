#!/bin/sh
set -eu
case "$1" in *[!0-9a-f]*|'') exit 2;; esac
sleep "$2"
docker unpause "$1"
