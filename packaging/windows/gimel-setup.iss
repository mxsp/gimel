; Gimel Windows Desktop App Installer (Inno Setup 6)
; Produces Gimel-Setup-x64.exe installing the native windowed Gimel Desktop Program
; (Gimel.exe, console=False, WebView2 / Edge app window) + gimel-cli.exe, with Start Menu
; and Desktop shortcuts, direct winget installation for Python 3.12 and Docker Desktop,
; optional Private-LAN Windows Firewall rule, uninstaller, and automatic Desktop App launch.

#ifndef AppVersion
  #define AppVersion "0.2.9"
#endif

[Setup]
AppId={{7F6A3B9C-4E12-4F5A-9A2B-8C7D1E2F3A4B}
AppName=Gimel
AppVersion={#AppVersion}
AppVerName=Gimel {#AppVersion}
AppPublisher=mxsp / FyreFly Systems GbR
AppPublisherURL=https://github.com/mxsp/gimel
AppSupportURL=https://github.com/mxsp/gimel/issues
AppUpdatesURL=https://github.com/mxsp/gimel/releases
DefaultDirName={autopf}\Gimel
DefaultGroupName=Gimel
AllowNoIcons=yes
LicenseFile=..\..\LICENSE
OutputDir=..\dist
OutputBaseFilename=Gimel-Setup-x64
SetupIconFile=gimel.ico
UninstallDisplayIcon={app}\Gimel.exe
WizardStyle=modern
WizardImageFile=wizard-side.bmp
WizardSmallImageFile=wizard-small.bmp
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Languages]
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "lanfirewall"; Description: "Windows-Firewall für lokales Netzwerk (LAN, Ports 8040/8041) freigeben (erfordert Admin-Rechte)"; GroupDescription: "Netzwerk"; Flags: unchecked
Name: "installpython"; Description: "Python 3.12 installieren über winget (falls nicht vorhanden, für Skripte, Agent Lab & Piper TTS)"; GroupDescription: "System-Komponenten (empfohlen)"
Name: "installdocker"; Description: "Docker Desktop installieren über winget (falls nicht vorhanden, für Container-Sandbox & Docker-Modus)"; GroupDescription: "System-Komponenten (empfohlen)"

[Files]
Source: "..\dist\gimel\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "install-deps.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "gimel.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Gimel (Master Admin & Start)"; Filename: "{app}\Gimel.exe"; IconFilename: "{app}\gimel.ico"
Name: "{group}\Gimel Production (Echtbetrieb)"; Filename: "{app}\Gimel.exe"; Parameters: "--target production"; IconFilename: "{app}\gimel.ico"
Name: "{group}\Gimel Playground (Demo)"; Filename: "{app}\Gimel.exe"; Parameters: "--target playground"; IconFilename: "{app}\gimel.ico"
Name: "{group}\Gimel Einrichtungs-Assistent"; Filename: "{app}\Gimel.exe"; Parameters: "--target setup"; IconFilename: "{app}\gimel.ico"
Name: "{group}\Gimel Server (Konsole)"; Filename: "{app}\gimel-cli.exe"; Parameters: "--mode both"; IconFilename: "{app}\gimel.ico"
Name: "{group}\{cm:UninstallProgram,Gimel}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Gimel"; Filename: "{app}\Gimel.exe"; IconFilename: "{app}\gimel.ico"; Tasks: desktopicon

[Run]
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""Gimel Localnet (8040-8041)"" dir=in action=allow protocol=TCP localport=8040-8041 profile=private"; Flags: runhidden waituntilterminated; Tasks: lanfirewall
Filename: "winget.exe"; Parameters: "install --id Python.Python.3.12 -e --accept-package-agreements --accept-source-agreements --scope user"; Flags: waituntilterminated skipifdoesntexist; StatusMsg: "Installiere Python 3.12 über winget..."; Tasks: installpython
Filename: "winget.exe"; Parameters: "install --id Docker.DockerDesktop -e --accept-package-agreements --accept-source-agreements"; Flags: waituntilterminated skipifdoesntexist; StatusMsg: "Installiere Docker Desktop über winget..."; Tasks: installdocker
Filename: "{app}\Gimel.exe"; Description: "Gimel Desktop-App jetzt starten"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Gimel Localnet (8040-8041)"""; Flags: runhidden; RunOnceId: "RemoveGimelFirewallRule"
