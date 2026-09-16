#!/usr/bin/env bash
# Launch an AppImage on the current X display, wait for its window to appear and
# paint, and fail if what it painted is black. A black window is how WebKitGTK
# reports a broken GPU path, which is the failure this exists to catch.
#
#   xvfb-run -a -s "-screen 0 1600x1000x24" bash scripts/smoke-appimage.sh app.AppImage
#
# Needs xvfb, xdotool and imagemagick. Waits for the window rather than sleeping
# a fixed time: a cold start on a CI runner took longer than 30 s and the old
# fixed sleep screenshotted an empty display every time.
set -u

# Absolute, so a bare filename in the working directory is still executable.
app=$(readlink -f -- "${1:?usage: smoke-appimage.sh <AppImage> [out.png]}")
out=${2:-smoke.png}
title=${SMOKE_TITLE:-PoB Redux}
map_timeout=${SMOKE_MAP_TIMEOUT:-150}
paint_timeout=${SMOKE_PAINT_TIMEOUT:-90}
floor=${SMOKE_MIN_BRIGHTNESS:-0.01}
# A window that painted the interface varies; one that is uniformly black or
# uniformly white painted nothing, whichever way the theme fell.
spread=${SMOKE_MIN_SPREAD:-0.01}
log=smoke-app.log

find_window() {
  local w
  w=$(xdotool search --onlyvisible --name "$title" 2>/dev/null | head -1)
  [ -z "$w" ] && w=$(xdotool search --name "$title" 2>/dev/null | head -1)
  printf '%s' "$w"
}

chmod +x "$app"
echo "launching $app on ${DISPLAY:-(no DISPLAY)}"
"$app" >"$log" 2>&1 &
pid=$!

win=""
started=$SECONDS
while [ $((SECONDS - started)) -lt "$map_timeout" ]; do
  win=$(find_window)
  [ -n "$win" ] && break
  # The app re-execs itself inside an AppImage to preload the host's wayland
  # libraries, which keeps the same pid, so this only trips on a real exit.
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "the app exited after $((SECONDS - started)) s without showing a window"
    break
  fi
  sleep 2
done

status=0
mean=0
if [ -z "$win" ]; then
  echo "no window titled \"$title\" within $((SECONDS - started)) s"
  import -window root "$out" 2>/dev/null || true
  status=1
else
  echo "window $win mapped after $((SECONDS - started)) s"
  xdotool getwindowgeometry "$win" 2>/dev/null || true
  started=$SECONDS
  sd=0
  while :; do
    import -window "$win" "$out" 2>/dev/null || import -window root "$out" 2>/dev/null || true
    mean=$(convert "$out" -colorspace Gray -format "%[fx:mean]" info: 2>/dev/null || echo 0)
    sd=$(convert "$out" -colorspace Gray -format "%[fx:standard_deviation]" info: 2>/dev/null || echo 0)
    # A uniform window makes imagemagick report the spread as nan, which awk
    # will happily compare as if it passed, so anything but a plain number is 0.
    awk -v m="$mean" -v f="$floor" -v s="$sd" -v p="$spread" 'BEGIN {
      if (m !~ /^[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$/) m = 0
      if (s !~ /^[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$/) s = 0
      exit (m + 0 > f && s + 0 > p) ? 0 : 1
    }' && break
    if [ $((SECONDS - started)) -ge "$paint_timeout" ]; then
      status=1
      break
    fi
    sleep 2
  done
  echo "brightness $mean (needs more than $floor), spread $sd (needs more than $spread), after $((SECONDS - started)) s"
fi

kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
echo "--- app output ---"
tail -60 "$log" 2>/dev/null || true
exit $status
