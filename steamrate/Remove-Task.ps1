# Removes the SteamRate scheduled task and stops the program. Run as administrator.
Unregister-ScheduledTask -TaskName 'SteamRate' -Confirm:$false -ErrorAction SilentlyContinue
Get-Process SteamRate -ErrorAction SilentlyContinue | Stop-Process -Force
'Task SteamRate removed.'
