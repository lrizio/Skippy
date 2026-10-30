; Close any running Skippy (it hides in the tray, so the user may not see it) before installing or uninstalling.
; The installer then removes the previous version itself (electron-builder runs the old uninstaller first).
!macro customInit
  nsExec::Exec 'taskkill /F /T /IM "Skippy.exe"'
  Pop $0
  Sleep 800
!macroend
!macro customUnInit
  nsExec::Exec 'taskkill /F /T /IM "Skippy.exe"'
  Pop $0
  Sleep 800
!macroend
