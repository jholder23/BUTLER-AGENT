; Butler — production desktop shortcut runs Butler.exe (no rebuild on each start).
!macro customInstall
  Delete "$DESKTOP\Butler.lnk"
  Delete "$DESKTOP\Butler New.lnk"
  Delete "$DESKTOP\Butler Updated.lnk"
  IfFileExists "$INSTDIR\Butler-Start.cmd" butlerDesktopStartCmd butlerDesktopExeOnly
  butlerDesktopStartCmd:
    CreateShortcut "$DESKTOP\Butler.lnk" "$INSTDIR\Butler-Start.cmd" "" "$INSTDIR\Butler.exe" 0
    Goto butlerMainDesktopDone
  butlerDesktopExeOnly:
    CreateShortcut "$DESKTOP\Butler.lnk" "$INSTDIR\Butler.exe" "" "$INSTDIR\Butler.exe" 0
  butlerMainDesktopDone:
  IfFileExists "$INSTDIR\Butler-Rebuild.cmd" 0 butlerRebuildShortcutDone
    CreateShortcut "$DESKTOP\Butler Rebuild.lnk" "$INSTDIR\Butler-Rebuild.cmd" "" "$INSTDIR\Butler.exe" 0
  butlerRebuildShortcutDone:
!macroend

!macro customUnInstall
  Delete "$DESKTOP\Butler.lnk"
  Delete "$DESKTOP\Butler New.lnk"
  Delete "$DESKTOP\Butler Updated.lnk"
  Delete "$DESKTOP\Butler Rebuild.lnk"
!macroend
