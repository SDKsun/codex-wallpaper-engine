@echo off
node "%~dp0scripts\server.mjs" --command "{\"action\":\"rotation_stop\"}"
pause
