#!/bin/sh
# SYNQ (.deb): load the device rule this package installs (/usr/lib/udev/rules.d/70-onboard-hub.rules),
# so the mice and keyboards SYNQ supports, already plugged in, can be opened by the signed-in user.
# A container without udev must not fail the install, so errors are ignored.
set -e
if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules && udevadm trigger || true
fi
exit 0
