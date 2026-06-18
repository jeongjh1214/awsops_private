#!/bin/bash
set -euo pipefail

exec "$(cd "$(dirname "$0")" && pwd)/09-stop-all.sh"
