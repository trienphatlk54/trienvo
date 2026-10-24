Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "c:\Users\Admin\Documents\Test-Websites\shopee-qr"
WshShell.Run "cmd.exe /c ""c:\Users\Admin\Documents\Test-Websites\shopee-qr\watchdog-service.bat""", 0, False
