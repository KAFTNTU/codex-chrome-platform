[Setup]
AppId={{9D0B7C38-4D6B-4E41-8D74-A11A070F66EF}
AppName=Codex Chrome Platform
AppVersion=0.3.0
AppPublisher=KAFTNTU
DefaultDirName={autopf}\Codex Chrome Platform
DefaultGroupName=Codex Chrome Platform
DisableProgramGroupPage=yes
OutputDir=..\dist-new
OutputBaseFilename=CodexChromePlatform-Setup-20260531-r2
Compression=lzma
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\Codex Chrome Platform.exe

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "..\dist-packager-fresh\CodexChromePlatform-win32-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "resources\app\dist\*;resources\app\dist-*;resources\app\dist-packager*\*;resources\app\node_modules\*;resources\app\.git\*"

[Icons]
Name: "{autoprograms}\Codex Chrome Platform"; Filename: "{app}\Codex Chrome Platform.exe"
Name: "{autodesktop}\Codex Chrome Platform"; Filename: "{app}\Codex Chrome Platform.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Codex Chrome Platform.exe"; Description: "Launch Codex Chrome Platform"; Flags: nowait postinstall skipifsilent
