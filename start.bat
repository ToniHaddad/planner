@echo off
rem Starts the planner on this computer and opens it in your browser.
cd /d "%~dp0"
where php >nul 2>nul
if errorlevel 1 goto nophp
php start.php %*
if errorlevel 1 pause
exit /b

:nophp
echo Planner needs PHP, which is not installed on this computer yet.
echo.
choice /c YN /m "Install PHP now (free, about 30 MB)"
if errorlevel 2 goto manual
winget install -e --id PHP.PHP.8.3
if errorlevel 1 goto manual
echo.
echo PHP is installed. Close this window and double-click start.bat again.
pause
exit /b

:manual
echo.
echo To install PHP yourself, open a terminal and run:
echo     winget install -e --id PHP.PHP.8.3
echo Then double-click start.bat again.
pause
exit /b 1
