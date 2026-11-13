Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
infra = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = infra & "\tray.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & ps1 & """"
shell.Run cmd, 0, False
