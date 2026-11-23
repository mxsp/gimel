; Gimel Windows Installer (Inno Setup 6)
; Produces Gimel-Setup-x64.exe with modern branding, Start Menu / Desktop
; shortcuts, optional Private-LAN Windows Firewall rule, uninstaller, and
; automatic launch of the Gimel UI Setup Wizard.

#ifndef AppVersion
  #define AppVersion "0.2.2"
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
UninstallDisplayIcon={app}\gimel.exe
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

[Files]
Source: "..\dist\gimel.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\Start-Gimel-Playground.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\Start-Gimel-Production.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\Start-Gimel-Both.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\Start-Gimel-Setup.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "gimel.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Gimel Einrichtungs-Assistent"; Filename: "{app}\gimel.exe"; Parameters: "--mode setup-ui"; IconFilename: "{app}\gimel.ico"
Name: "{group}\Gimel Production (Echtbetrieb)"; Filename: "{app}\gimel.exe"; Parameters: "--mode production"; IconFilename: "{app}\gimel.ico"
Name: "{group}\Gimel Playground (Demo)"; Filename: "{app}\gimel.exe"; Parameters: "--mode playground"; IconFilename: "{app}\gimel.ico"
Name: "{group}\Gimel Beide (Playground + Production)"; Filename: "{app}\gimel.exe"; Parameters: "--mode both"; IconFilename: "{app}\gimel.ico"
Name: "{group}\{cm:UninstallProgram,Gimel}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Gimel"; Filename: "{app}\gimel.exe"; Parameters: "--mode setup-ui"; IconFilename: "{app}\gimel.ico"; Tasks: desktopicon

[Run]
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""Gimel Localnet (8040-8041)"" dir=in action=allow protocol=TCP localport=8040-8041 profile=private"; Flags: runhidden waituntilterminated; Tasks: lanfirewall
Filename: "{app}\gimel.exe"; Parameters: "--mode setup-ui"; Description: "Gimel Einrichtungs-Assistent jetzt öffnen"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Gimel Localnet (8040-8041)"""; Flags: runhidden; RunOnceId: "RemoveGimelFirewallRule"
