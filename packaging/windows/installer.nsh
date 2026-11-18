; Extra shortcuts for the per-user installer: a "room" shortcut that starts the app as a satellite of bija
; (docs/features/satellite.md). Removed again on uninstall.
!macro customInstall
  CreateShortCut "$SMPROGRAMS\AI Embodied Room (satellite).lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--satellite"
  CreateShortCut "$DESKTOP\AI Embodied Room (satellite).lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--satellite"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\AI Embodied Room (satellite).lnk"
  Delete "$DESKTOP\AI Embodied Room (satellite).lnk"
!macroend
