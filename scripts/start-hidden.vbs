Option Explicit

Dim shell, fso, scriptDirectory, powerShell, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
powerShell = "pwsh.exe"
command = powerShell & " -NoProfile -ExecutionPolicy Bypass -File """ & scriptDirectory & "\start-hidden.ps1"""

' 0 = hidden window, False = do not wait.
shell.Run command, 0, False
