#!/bin/sh
# SYNQ (.deb), before removal: ask any running SYNQ Helper to quit. SIGTERM makes it put every
# device back on its everyday settings first (as the Windows uninstaller's --stop does). Not on upgrade.
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
    if command -v pkill >/dev/null 2>&1; then
        pkill -TERM -x synq-helper || true
    fi
fi
exit 0
