## New in beta 7

- **SYNQ Helper starts on a fresh Windows.** It needed the Visual C++ runtime (VCRUNTIME140.dll), which many PCs have
  from other apps but a clean Windows doesn't; there it couldn't start at all. The runtime is now built into
  `synq-helper.exe`, both the one on the website and the one the installer brings. Found by the new Windows Sandbox
  test, which installs the helper from the website's link on a clean Windows and talks to it as synqhub.app does.
- **The helper's "allow this site?" box** now names everything a site can reach through it: mouse, keyboard and
  controller settings, the EQ, monitors, webcams and lights.
