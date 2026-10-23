@echo off
rem Windows Task Scheduler "RoadnameLocalData" runs this daily; the log is scripts\local-update.log (ignored).
cd /d "%~dp0.."
set PYTHONUTF8=1
python scripts\local-update.py >> scripts\local-update.log 2>&1
