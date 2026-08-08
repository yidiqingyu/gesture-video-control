@echo off
rem ============================================================
rem pack-crx.bat —— 打包 .crx 的便捷入口（调用 pack-crx.ps1）
rem ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pack-crx.ps1"
