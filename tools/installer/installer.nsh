; Quartz-Setup.exe additions to electron-builder's NSIS script (nsis.include in electron-builder.yml).
;
; Uninstall: forget the default-browser registration, but only the part that is THIS install's.
; Quartz writes it itself (first-run welcome or Settings, register-default-browser.ps1 -InstalledExe):
; HKCU only, three keys and one value. A copy of Quartz run from a folder registers the same key
; names with its own command line, so each key goes only while its command still names this
; install's exe; anything else is left exactly as it is. An update (the new installer running the
; old uninstaller, --updated) keeps everything: the same exe path is registered again at once.
; The profile (%APPDATA%\Quartz) is never touched (deleteAppDataOnUninstall: false).

!macro quartzForgetKey SUBKEY EXPECT
  ReadRegStr $0 HKCU "${SUBKEY}\shell\open\command" ""
  ${if} $0 == `${EXPECT}`
    DeleteRegKey HKCU "${SUBKEY}"
    DetailPrint "Removed HKCU\${SUBKEY}"
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $0
    !insertmacro quartzForgetKey "Software\Classes\QuartzURL" `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"`
    !insertmacro quartzForgetKey "Software\Classes\QuartzHTML" `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"`
    ReadRegStr $0 HKCU "Software\Clients\StartMenuInternet\Quartz\shell\open\command" ""
    ${if} $0 == `"$INSTDIR\${APP_EXECUTABLE_FILENAME}"`
      DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Quartz"
      DeleteRegValue HKCU "Software\RegisteredApplications" "Quartz"
      DetailPrint "Removed HKCU\Software\Clients\StartMenuInternet\Quartz"
    ${endIf}
    Pop $0
  ${endIf}
!macroend
