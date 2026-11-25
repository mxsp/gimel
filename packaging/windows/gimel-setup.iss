; Gimel Windows Desktop App Installer (Inno Setup 6)
; Produces Gimel-Setup-x64.exe installing the native windowed Gimel Desktop Program
; (Gimel.exe, console=False) + gimel-cli.exe, with Start Menu and Desktop shortcuts,
; built-in Production Admin account wizard page, silent background winget tasks,
; optional Private-LAN Windows Firewall rule, uninstaller, and zero terminal windows.

#ifndef AppVersion
  #define AppVersion "1.0.3"
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
DisableProgramGroupPage=yes
DisableDirPage=auto
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
Name: "lanfirewall"; Description: "Optional: Windows-Firewall für lokales Netzwerk (LAN, Ports 8040/8041) freigeben (erfordert Admin-Rechte)"; GroupDescription: "Netzwerk"; Flags: unchecked
Name: "installpython"; Description: "Optional: System-Python 3.12 im Hintergrund nachinstallieren (Gimel selbst enthält bereits eine eigene Laufzeit)"; GroupDescription: "Optionale Zusatz-Komponenten"; Flags: unchecked
Name: "installdocker"; Description: "Optional: Docker Desktop im Hintergrund installieren (nur für Container-Sandbox nötig)"; GroupDescription: "Optionale Zusatz-Komponenten"; Flags: unchecked

[Files]
Source: "..\dist\gimel\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "install-deps.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "gimel.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Gimel (Desktop & Master Admin)"; Filename: "{app}\Gimel.exe"; IconFilename: "{app}\gimel.ico"
Name: "{group}\Gimel Production (Echtbetrieb)"; Filename: "{app}\Gimel.exe"; Parameters: "--target production"; IconFilename: "{app}\gimel.ico"
Name: "{group}\Gimel Playground (Demo-Werk)"; Filename: "{app}\Gimel.exe"; Parameters: "--target playground"; IconFilename: "{app}\gimel.ico"
Name: "{group}\{cm:UninstallProgram,Gimel}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Gimel"; Filename: "{app}\Gimel.exe"; IconFilename: "{app}\gimel.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\Gimel.exe"; Parameters: "--mode production --init-only --admin-user ""{code:GetAdminUser}"" --admin-password ""{code:GetAdminPassword}"""; Flags: runhidden waituntilterminated; StatusMsg: "Richte Production Admin-Konto ein..."; Check: HasAdminCredentials
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""Gimel Localnet (8040-8041)"" dir=in action=allow protocol=TCP localport=8040-8041 profile=private"; Flags: runhidden waituntilterminated; Tasks: lanfirewall
Filename: "winget.exe"; Parameters: "install --id Python.Python.3.12 -e --silent --accept-package-agreements --accept-source-agreements --scope user"; Flags: runhidden waituntilterminated skipifdoesntexist; StatusMsg: "Installiere Python 3.12 im Hintergrund..."; Tasks: installpython
Filename: "winget.exe"; Parameters: "install --id Docker.DockerDesktop -e --silent --accept-package-agreements --accept-source-agreements"; Flags: runhidden waituntilterminated skipifdoesntexist; StatusMsg: "Installiere Docker Desktop im Hintergrund..."; Tasks: installdocker
Filename: "{app}\Gimel.exe"; Description: "Gimel Desktop & Master Admin jetzt öffnen"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Gimel Localnet (8040-8041)"""; Flags: runhidden; RunOnceId: "RemoveGimelFirewallRule"

[Code]
var
  AdminPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  AdminPage := CreateInputQueryPage(
    wpSelectTasks,
    'Production Admin-Konto (Optional)',
    'Erstzugang für den Echtbetrieb direkt anlegen',
    'Legen Sie jetzt Ihr erstes Administrator-Konto für den Echtbetrieb (Production) fest, ' +
    'oder verwalten Sie Konten später jederzeit im Gimel Desktop-Programm.'
  );
  AdminPage.Add('Admin-Benutzername:', False);
  AdminPage.Add('Admin-Passwort (mind. 8 Zeichen, leer lassen zum Überspringen):', False);
  AdminPage.Values[0] := 'admin';
  AdminPage.Values[1] := '';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Pw: String;
begin
  Result := True;
  if CurPageID = AdminPage.ID then
  begin
    Pw := Trim(AdminPage.Values[1]);
    if (Pw <> '') and (Length(Pw) < 8) then
    begin
      MsgBox('Das Admin-Passwort muss mindestens 8 Zeichen lang sein (oder lassen Sie das Feld leer).', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function HasAdminCredentials: Boolean;
begin
  Result := (Trim(AdminPage.Values[0]) <> '') and (Length(Trim(AdminPage.Values[1])) >= 8);
end;

function GetAdminUser(Param: String): String;
begin
  Result := Trim(AdminPage.Values[0]);
end;

function GetAdminPassword(Param: String): String;
begin
  Result := Trim(AdminPage.Values[1]);
end;
