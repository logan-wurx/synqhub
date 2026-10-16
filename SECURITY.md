# Security

SYNQ sends commands to hardware and installs an audio engine with administrator approval, so we treat two kinds
of problem as security issues:

- anything that could **damage or brick a device** (a command that reaches a device although its allowlist should have
  refused it, a firmware or bootloader path that shouldn't be reachable, a setting that leaves a device unusable);
- anything that could **harm the PC or its owner's data** (the installer, the EQ engine setup, SYNQ Helper, the
  website bridge, or a way for a web page to reach a device without the person's consent).

## Reporting

Please **don't open a public issue** for these. Use GitHub's private reporting instead: the repository's **Security**
tab → **Report a vulnerability**. Include what you did, the device (model, firmware, USB id) and, if you can, a
diagnostics file (**Save diagnostics** on the device's page).

You'll get a reply within a few days. Fixes ship in the next build, with credit unless you'd rather not be named.

## Supported versions

Only the newest build gets fixes. SYNQ is in beta; please update before reporting.
