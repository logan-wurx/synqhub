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

## What the app's window may load

The desktop app's window runs under a Content Security Policy (`app.security.csp` in `src-tauri/tauri.conf.json`), as
strict as the website's (`public-web/_headers`): only SYNQ's own scripts run (no inline scripts, no `eval`), and it
connects only to SYNQ's own core (`ipc:`), VIA's keyboard list (`usevia.app`) and the AutoEq headphone list
(`raw.githubusercontent.com`). Images may also come from Steam's image servers (`*.steamstatic.com`) for game art.
Styles keep `'unsafe-inline'` (the animation and number libraries set inline styles), so
`dangerousDisableAssetCspModification` is set for `style-src` only: Tauri's nonce would otherwise switch that off.
Anything new the window needs from the internet has to be added there, or it is blocked.

## Supported versions

Only the newest build gets fixes. SYNQ is in beta; please update before reporting.
