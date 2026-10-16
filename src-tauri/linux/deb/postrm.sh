#!/bin/sh
# SYNQ (.deb), after removal: udev forgets the device rule the package took away.
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
    if command -v udevadm >/dev/null 2>&1; then
        udevadm control --reload-rules || true
    fi
fi
exit 0
