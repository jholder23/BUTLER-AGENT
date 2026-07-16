Butler 0.1.1 — production drop

Folders:
  App\\          Portable app — run App\\Butler.exe or App\\Butler-Start.cmd
  installer\\    Windows setup (optional install to Program Files)

Desktop: after "npm run release", a shortcut "Butler.lnk" is created on your Desktop
pointing at this portable App\\Butler.exe (if the build finished on this machine).

Dev rebuild: open the git repo (e.g. D:\\BUTLER) and run from ui: npm run build:app
Or set BUTLER_UI_DIR to the repo ui folder and run Butler-Rebuild.cmd from an older package.

Knowledge API + embedded Python ship inside the app under resources.
