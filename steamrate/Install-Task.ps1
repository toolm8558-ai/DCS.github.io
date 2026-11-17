# Registers SteamRate to start when PAE logs on (three minutes later, after TrendToMongo) and to be
# checked every five minutes so it comes back if it ever stops. Run as administrator.
# Remove-Task.ps1 undoes this.
$ErrorActionPreference = 'Stop'
$home_ = Split-Path -Parent $MyInvocation.MyCommand.Path
$user = "$env:COMPUTERNAME\PAE"
$action = New-ScheduledTaskAction -Execute (Join-Path $home_ 'SteamRate.exe') -WorkingDirectory $home_
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$logon.Delay = 'PT3M'
$check = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'SteamRate' -Action $action -Trigger $logon, $check -Principal $principal -Settings $settings -Force | Out-Null
'Task SteamRate installed.'
