@echo off
echo ========================================================================
echo           AegisRAG — Automated Environment Setup ^& Startup              
echo ========================================================================

:: 1. Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed. Please install Node.js 18+ to proceed.
    exit /b 1
)
echo [OK] Node.js detected.

:: 2. Setup Environment Variables
if not exist .env (
    echo [INFO] Creating .env from .env.example...
    copy .env.example .env >nul
    echo [OK] .env created with default development configuration.
) else (
    echo [OK] .env configuration already present.
)

:: 3. Create data directory
if not exist data mkdir data

:: 4. Install Dependencies
echo [INFO] Installing project dependencies...
call npm install --silent

:: 5. Run Database Seeding
echo [INFO] Seeding historical baseline runs into SQLite...
call npm run seed

:: 6. Run Test Suite
echo [INFO] Running automated validation test suites...
call npm test

:: 7. Start Dashboard & API Server
echo.
echo ========================================================================
echo [OK] Setup complete! Launching AegisRAG API ^& Dashboard on port 3001...
echo ========================================================================
call npm run server
