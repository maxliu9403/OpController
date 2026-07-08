!macro OPCTRL_KILL_PROCESS PROCESS_NAME
  DetailPrint "Stopping ${PROCESS_NAME} if it is still running..."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "${PROCESS_NAME}"'
  Sleep 500
!macroend

!macro OPCTRL_REMOVE_RUNTIME_DIST RUNTIME_DIST_DIR
  DetailPrint "Removing old runtime files if present: ${RUNTIME_DIST_DIR}"
  RMDir /r "${RUNTIME_DIST_DIR}"
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro OPCTRL_KILL_PROCESS "opcontroller-runtime.exe"
  !insertmacro OPCTRL_KILL_PROCESS "opcontroller-desktop.exe"
  !insertmacro OPCTRL_KILL_PROCESS "opcontroller.exe"
  !insertmacro OPCTRL_KILL_PROCESS "OpController.exe"
  !insertmacro OPCTRL_KILL_PROCESS "OpController Desktop.exe"

  ; Runtime resources contain DLLs loaded by the Python sidecar. On Windows,
  ; locked DLLs cannot be overwritten during an upgrade, so remove the old
  ; resource folder after stopping stale processes.
  !insertmacro OPCTRL_REMOVE_RUNTIME_DIST "$INSTDIR\runtime-dist"
  !insertmacro OPCTRL_REMOVE_RUNTIME_DIST "$LOCALAPPDATA\OpController\runtime-dist"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro OPCTRL_KILL_PROCESS "opcontroller-runtime.exe"
  !insertmacro OPCTRL_KILL_PROCESS "opcontroller-desktop.exe"
  !insertmacro OPCTRL_KILL_PROCESS "opcontroller.exe"
  !insertmacro OPCTRL_KILL_PROCESS "OpController.exe"
  !insertmacro OPCTRL_KILL_PROCESS "OpController Desktop.exe"
!macroend
