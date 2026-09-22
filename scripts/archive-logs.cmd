@echo off
REM Archivage des logs Hearthstone (phase 0).
REM Lance par le planificateur de taches Windows, voir docs/ARCHIVAGE.md.
cd /d "%~dp0.."
call npm run archive
