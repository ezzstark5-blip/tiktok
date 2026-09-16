@echo off
setlocal
title KeyForge - API, Site e Discord Bot
color 0F

cd /d "%~dp0"

echo.
echo  ==============================================
echo           KEYFORGE - INICIANDO SISTEMA
echo  ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Node.js nao foi encontrado.
    echo Instale o Node.js em https://nodejs.org e tente novamente.
    echo.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERRO] npm nao foi encontrado.
    echo Reinstale o Node.js incluindo o npm.
    echo.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [AVISO] Arquivo .env nao encontrado.
    if exist ".env.example" (
        copy /y ".env.example" ".env" >nul
        echo [OK] .env criado. Configure os dados do Discord quando desejar.
    )
)

if not exist "node_modules\" (
    echo [1/2] Instalando dependencias...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERRO] Nao foi possivel instalar as dependencias.
        pause
        exit /b 1
    )
    echo [OK] Dependencias instaladas.
    echo.
)

echo [2/2] Iniciando em http://localhost:3000
echo Para encerrar, pressione CTRL+C.
echo.

call npm start

if errorlevel 1 (
    echo.
    echo [ERRO] O sistema foi encerrado com uma falha.
    pause
    exit /b 1
)

endlocal
