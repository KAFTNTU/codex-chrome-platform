!include "MUI2.nsh"

Name "Codex Chrome Platform"
OutFile "..\dist\CodexChromePlatform-Setup.exe"
InstallDir "$PROGRAMFILES64\Codex Chrome Platform"
InstallDirRegKey HKCU "Software\CodexChromePlatform" "Install_Dir"
RequestExecutionLevel user

!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "..\dist\win-unpacked\*.*"

  WriteRegStr HKCU "Software\CodexChromePlatform" "Install_Dir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexChromePlatform" "DisplayName" "Codex Chrome Platform"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexChromePlatform" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexChromePlatform" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexChromePlatform" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\Codex Chrome Platform"
  CreateShortcut "$SMPROGRAMS\Codex Chrome Platform\Codex Chrome Platform.lnk" "$INSTDIR\Codex Chrome Platform.exe"
  CreateShortcut "$DESKTOP\Codex Chrome Platform.lnk" "$INSTDIR\Codex Chrome Platform.exe"

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Codex Chrome Platform.lnk"
  Delete "$SMPROGRAMS\Codex Chrome Platform\Codex Chrome Platform.lnk"
  RMDir "$SMPROGRAMS\Codex Chrome Platform"

  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexChromePlatform"
  DeleteRegKey HKCU "Software\CodexChromePlatform"
SectionEnd
