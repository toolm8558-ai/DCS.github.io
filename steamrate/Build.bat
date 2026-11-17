@echo off
rem Builds SteamRate.exe with the .NET Framework compiler, using the MongoDB driver in lib\
rem (here or in a TrendToMongo folder beside this one).
set "FW=%WINDIR%\Microsoft.NET\Framework\v4.0.30319"
set "L=%~dp0lib"
if not exist "%L%\MongoDB.Driver.dll" set "L=%~dp0..\TrendToMongo\lib"
if not exist "%L%\MongoDB.Driver.dll" (
  echo MongoDB driver not found in lib\ or ..\TrendToMongo\lib
  exit /b 1
)
"%FW%\csc.exe" /nologo /target:exe /platform:x86 /optimize+ /nowarn:1701,1702 /r:"%L%\MongoDB.Driver.dll" /r:"%L%\MongoDB.Bson.dll" /r:"%L%\MongoDB.Driver.Core.dll" /r:"%FW%\netstandard.dll" /out:"%~dp0SteamRate.exe" "%~dp0SteamRate.cs"
if errorlevel 1 exit /b 1
echo Built SteamRate.exe
