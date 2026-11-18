#!/bin/sh
# Starts the planner on this computer and opens it in your browser.
cd "$(dirname "$0")" || exit 1
if ! command -v php >/dev/null 2>&1; then
  echo "Planner needs PHP, which is not installed yet."
  echo
  echo "  macOS:          brew install php"
  echo "  Debian/Ubuntu:  sudo apt install php-cli php-sqlite3 php-curl php-mbstring"
  echo "  Fedora:         sudo dnf install php-cli php-pdo php-mbstring"
  echo
  echo "Install it, then run ./start.sh again."
  exit 1
fi
exec php start.php "$@"
