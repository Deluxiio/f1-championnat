@echo off
title Championnat F1 25 - Enregistreur (laisser ouvert pendant les courses)
cd /d "%~dp0enregistreur"
py -3 -X utf8 f1champ.py
if errorlevel 1 pause
