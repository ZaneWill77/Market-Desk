#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi
if [ -f .env ]; then set -a; . ./.env; set +a; fi
exec .venv/bin/python -m app
