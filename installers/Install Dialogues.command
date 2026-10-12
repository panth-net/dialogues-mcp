#!/usr/bin/env sh
# Double-click installer: builds this downloaded folder and connects one app.
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
sh "$DIR/setup.sh" "" --from-checkout
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo ""
  echo "Setup did not finish. Read the message above for what to do next."
fi
echo ""
printf "Press Return to close this window: "
read _ || true
exit "$STATUS"
