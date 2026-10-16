; SYNQ installer hooks (tauri.conf.json > bundle.windows.nsis.installerHooks).
;
; The installer runs elevated (installMode perMachine), so the EQ engine needs no second prompt.
; When the engine (Equalizer APO) isn't on this PC yet, SYNQ's own helper installs it silently
; from the bundled official installer (checked against its SHA-256), puts it on the default output
; and confirms Windows loads it. If it's already installed, nothing about it is touched. See
; docs/eq-engine.md.
;
; SYNQ Helper (synq-helper.exe, docs/helper.md) is installed next to the app and stays off until
; the person turns it on in Settings. The installer never starts it (it would run elevated): before an
; update it asks a running helper to quit, after it puts the sign-in entry back only if the helper was on,
; and the uninstaller stops it, removes its sign-in entry and deletes it. The file is built by
; `npm run build:helper` (tauri.conf.json > build.beforeBundleCommand) into src-tauri/target/release.

; Resolved here, when this file is included from src-tauri\installer: inside a macro ${__FILEDIR__}
; would expand at the call site (the generated installer.nsi in the build's target folder) instead.
!define SYNQ_HELPER_EXE "${__FILEDIR__}\..\target\release\synq-helper.exe"

!macro NSIS_HOOK_PREINSTALL
  ; SYNQ was called OnBoard Hub: that install sits in another folder under another uninstall entry, so it goes first,
  ; quietly. Its uninstaller stops OnBoard Helper and removes its sign-in entry. The settings (app data, kept under the
  ; same app id) and the EQ engine stay, and SYNQ Helper puts its sign-in entry back below if it was on.
  Push $R8
  Push $R9
  ReadRegStr $R8 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OnBoard Hub" "InstallLocation"
  ; The value is quoted.
  StrCpy $R9 $R8 1
  ${If} $R9 == '"'
    StrCpy $R8 $R8 "" 1
    StrCpy $R8 $R8 -1
  ${EndIf}
  ${If} $R8 != ""
  ${AndIf} ${FileExists} "$R8\uninstall.exe"
    DetailPrint "Removing the old OnBoard Hub..."
    ; _?= runs the uninstaller in place, so ExecWait waits for it; it then leaves itself behind.
    ExecWait '"$R8\uninstall.exe" /S _?=$R8'
    Delete "$R8\uninstall.exe"
    RMDir "$R8"
  ${EndIf}
  Pop $R9
  Pop $R8

  ${If} ${FileExists} "$INSTDIR\synq-helper.exe"
    DetailPrint "Stopping SYNQ Helper for the update..."
    ExecWait '"$INSTDIR\synq-helper.exe" --stop'
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Setting up the EQ engine (Equalizer APO)..."
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --eq-engine install --only-if-missing' $0
  ${If} $0 == 0
    DetailPrint "EQ engine ready."
  ${ElseIf} $0 == 3
    DetailPrint "EQ engine installed. Windows will finish loading it after a restart."
  ${Else}
    DetailPrint "The EQ engine wasn't set up (code $0). SYNQ will offer to set it up when it opens."
  ${EndIf}

  ; SYNQ Helper: off unless the person turned it on before (then only its sign-in entry is restored).
  SetOutPath "$INSTDIR"
  File "/oname=synq-helper.exe" "${SYNQ_HELPER_EXE}"
  ExecWait '"$INSTDIR\synq-helper.exe" --register'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} ${FileExists} "$INSTDIR\synq-helper.exe"
    DetailPrint "Stopping SYNQ Helper..."
    ExecWait '"$INSTDIR\synq-helper.exe" --uninstall'
  ${EndIf}
  ; In case the helper couldn't run: its sign-in entry goes either way.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OnBoardHelper"
  Delete /REBOOTOK "$INSTDIR\synq-helper.exe"
!macroend
