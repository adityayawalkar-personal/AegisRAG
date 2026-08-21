#!/usr/bin/env bash
set -e

echo "========================================================================"
echo "          AegisRAG — Automated Environment Setup & Startup              "
echo "========================================================================"

# 1. Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed. Please install Node.js 18+ to proceed."
    exit 1
fi
echo "✓ Node.js $(node -v) detected."

# 2. Setup Environment Variables
if [ ! -f .env ]; then
    echo "-> Creating .env from .env.example..."
    cp .env.example .env
    # Generate random API Auth Secret
    RANDOM_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
    sed -i "s/your_secure_random_token_here/${RANDOM_SECRET}/g" .env
    echo "✓ .env created with freshly generated secure API_AUTH_SECRET."
else
    echo "✓ .env configuration already present."
fi

# 3. Create data directory
mkdir -p data

# 4. Install Dependencies
echo "-> Installing project dependencies..."
npm install --silent

# 5. Run Database Seeding
echo "-> Seeding historical baseline runs into SQLite..."
npm run seed

# 6. Run Test Suite
echo "-> Running automated validation test suites..."
npm test

# 7. Start Dashboard & API Server
echo ""
echo "========================================================================"
echo "🎉 Setup complete! Launching AegisRAG API & Dashboard on port 3001..."
echo "========================================================================"
npm run server
