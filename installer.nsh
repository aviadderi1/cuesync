!macro customUnInstall
  ; Electron's app.getPath('userData') uses package.json's "name" field
  ; ("cue-sync") by default — this is the exact, guaranteed-correct
  ; folder to remove on uninstall, independent of any automatic name
  ; detection elsewhere in the build.
  RMDir /r "$APPDATA\cue-sync"
!macroend
