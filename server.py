#!/usr/bin/env python3
"""Shot Log server: serves the PWA from ./public, a small sync API and
espresso machine power control through Home Assistant.

Only uses the Python standard library.

    python3 server.py                 # port 8000, token from $SHOTLOG_TOKEN or data/token
    python3 server.py --port 8080 --host 0.0.0.0

Machine power (optional) is enabled by setting HA_URL, HA_TOKEN and HA_ENTITY
(or --ha-url / --ha-token / --ha-entity). The machine is switched off automatically
after AUTO_OFF_MINUTES (--auto-off, default 60, 0 = never).

API (requires header "Authorization: Bearer <token>"):
    GET  /api/ping            -> {"ok": true}
    POST /api/sync            -> body: client state, response: merged state
    GET  /api/power           -> machine state, schedules, timers, next run
    POST /api/power           -> {"action": "on" | "off"}
    POST /api/power/schedule  -> {"weekly": [...], "timers": [...]}
"""

import argparse
import hmac
import json
import os
import re
import secrets
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
MAX_BODY = 20 * 1024 * 1024  # 20 MB

SCHEDULER_INTERVAL = 15        # seconds between scheduler checks
WEEKLY_GRACE = timedelta(minutes=3)    # fire a weekly slot at most this late
TIMER_GRACE = timedelta(minutes=10)    # drop one-off timers that are older than this

lock = threading.Lock()


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def write_json_atomic(path, data):
    # write to a temp file and rename, so a crash never leaves a half-written file
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


# ---------- sync ----------


def empty_state():
    return {"beans": [], "shots": [], "recipes": [], "settings": {}, "customFlavors": [], "deleted": {}}


def merge(a, b):
    """Last-write-wins merge per record. Must match mergeStates() in public/app.js."""
    deleted = dict(a.get("deleted") or {})
    for rid, t in (b.get("deleted") or {}).items():
        if isinstance(t, str) and (rid not in deleted or t > deleted[rid]):
            deleted[rid] = t

    def merge_list(x, y):
        by_id = {}
        for r in list(x or []) + list(y or []):
            if not isinstance(r, dict) or not isinstance(r.get("id"), str):
                continue
            cur = by_id.get(r["id"])
            if cur is None or (r.get("updatedAt") or "") > (cur.get("updatedAt") or ""):
                by_id[r["id"]] = r
        out = []
        for r in by_id.values():
            t = deleted.get(r["id"])
            if t and t >= (r.get("updatedAt") or ""):
                continue
            if t:
                del deleted[r["id"]]  # edited after deletion: record wins
            out.append(r)
        return out

    beans = merge_list(a.get("beans"), b.get("beans"))
    shots = merge_list(a.get("shots"), b.get("shots"))
    recipes = merge_list(a.get("recipes"), b.get("recipes"))
    sa, sb = a.get("settings") or {}, b.get("settings") or {}
    settings = sb if (sb.get("updatedAt") or "") > (sa.get("updatedAt") or "") else sa
    flavors = list(dict.fromkeys(list(a.get("customFlavors") or []) + list(b.get("customFlavors") or [])))
    return {"beans": beans, "shots": shots, "recipes": recipes, "settings": settings, "customFlavors": flavors, "deleted": deleted}


class Store:
    def __init__(self, path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def read(self):
        if not self.path.exists():
            return empty_state()
        with self.path.open(encoding="utf-8") as f:
            return {**empty_state(), **json.load(f)}

    def sync(self, incoming):
        with lock:
            merged = merge(self.read(), incoming)
            write_json_atomic(self.path, merged)
            return merged


# ---------- machine power (Home Assistant) ----------


class HomeAssistant:
    """Switches one entity (switch, input_boolean, light, ...) via Home Assistant's REST API."""

    def __init__(self, url, token, entity):
        self.url = url.rstrip("/")
        self.token = token
        self.entity = entity

    def _request(self, method, path, body=None):
        req = urllib.request.Request(
            self.url + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return json.loads(res.read() or b"null")
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Home Assistant returned HTTP {e.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            reason = getattr(e, "reason", e)
            raise RuntimeError(f"Cannot reach Home Assistant ({reason})") from None

    def state(self):
        data = self._request("GET", f"/api/states/{self.entity}")
        return {
            "state": data.get("state", "unknown"),
            "name": (data.get("attributes") or {}).get("friendly_name") or self.entity,
        }

    def turn(self, on):
        service = "turn_on" if on else "turn_off"
        self._request("POST", f"/api/services/homeassistant/{service}", {"entity_id": self.entity})


TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def parse_iso(value):
    dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("timestamp needs a time zone")
    return dt


def clean_schedule(body):
    """Validate the schedule sent by the app. Raises ValueError on bad input."""
    weekly = []
    for entry in body.get("weekly") or []:
        days = sorted({int(d) for d in entry.get("days") or [] if 0 <= int(d) <= 6})  # 0 = Monday
        if not TIME_RE.match(str(entry.get("time", ""))):
            raise ValueError(f"invalid time {entry.get('time')!r}")
        if not days:
            raise ValueError("a weekly schedule needs at least one day")
        weekly.append({
            "id": str(entry.get("id") or secrets.token_hex(4)),
            "time": entry["time"],
            "days": days,
            "enabled": bool(entry.get("enabled", True)),
        })
    timers = []
    for entry in body.get("timers") or []:
        at = parse_iso(entry.get("at"))
        timers.append({
            "id": str(entry.get("id") or secrets.token_hex(4)),
            "at": at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        })
    timers.sort(key=lambda t: t["at"])
    return weekly, timers


class PowerScheduler:
    def __init__(self, path, ha, auto_off_minutes=60):
        self.path = path
        self.ha = ha
        self.auto_off = timedelta(minutes=auto_off_minutes) if auto_off_minutes > 0 else None
        self.lock = threading.Lock()
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        self.weekly = data.get("weekly", [])
        self.timers = data.get("timers", [])
        self.fired = data.get("fired", {})         # weekly id -> date it last fired
        self.last_event = data.get("lastEvent")
        self.on_since = data.get("onSince")        # when the machine was last seen switching on

    def _save(self):
        write_json_atomic(self.path, {
            "weekly": self.weekly, "timers": self.timers, "fired": self.fired, "lastEvent": self.last_event,
            "onSince": self.on_since,
        })

    def set_schedule(self, weekly, timers):
        with self.lock:
            self.weekly, self.timers = weekly, timers
            ids = {w["id"] for w in weekly}
            self.fired = {k: v for k, v in self.fired.items() if k in ids}
            self._save()

    def switch(self, on, source, now=None):
        """Switch the machine and remember the outcome. Raises RuntimeError on failure."""
        now = now or datetime.now(timezone.utc)
        event = {"at": now.isoformat(), "action": "on" if on else "off", "source": source}
        try:
            self.ha.turn(on)
            event["ok"] = True
            log(f"machine {event['action']} ({source})")
        except RuntimeError as e:
            event.update(ok=False, error=str(e))
            log(f"machine {event['action']} FAILED ({source}): {e}")
            raise
        finally:
            with self.lock:
                self.last_event = event
                if event["ok"]:
                    # (re)start the auto-off countdown on every power-on
                    self.on_since = now.isoformat() if on else None
                self._save()

    def due(self, now):
        """Return the list of (source) entries to fire now and update bookkeeping."""
        local = now.astimezone()
        today = local.date().isoformat()
        fire = []
        with self.lock:
            for w in self.weekly:
                if not w.get("enabled", True) or local.weekday() not in w["days"]:
                    continue
                hh, mm = map(int, w["time"].split(":"))
                slot = local.replace(hour=hh, minute=mm, second=0, microsecond=0)
                if slot <= local < slot + WEEKLY_GRACE and self.fired.get(w["id"]) != today:
                    self.fired[w["id"]] = today
                    fire.append(f"schedule {w['time']}")
            remaining = []
            for t in self.timers:
                at = parse_iso(t["at"])
                if at > now:
                    remaining.append(t)
                elif now - at <= TIMER_GRACE:
                    fire.append("timer")
                else:
                    log(f"dropping missed timer {t['at']}")
            changed = bool(fire) or len(remaining) != len(self.timers)
            self.timers = remaining
            if changed:
                self._save()
        return fire

    def tick(self, now=None):
        now = now or datetime.now(timezone.utc)
        for source in self.due(now):
            try:
                self.switch(True, source, now)
            except RuntimeError:
                pass  # already logged and stored as last event
        if self.auto_off:
            self.check_auto_off(now)

    def check_auto_off(self, now):
        """Switch off after `auto_off` of on-time, however the machine was switched on."""
        try:
            state = self.ha.state()["state"]
        except RuntimeError:
            return  # can't tell; try again on the next tick
        with self.lock:
            if state != "on":
                if self.on_since:
                    self.on_since = None
                    self._save()
                return
            if not self.on_since:
                # switched on outside the app (Home Assistant, the plug's button, ...)
                self.on_since = now.isoformat()
                self._save()
                return
            expired = now - parse_iso(self.on_since) >= self.auto_off
        if expired:
            try:
                self.switch(False, "auto-off", now)
            except RuntimeError:
                pass  # retried on the next tick

    def auto_off_at(self):
        if not (self.auto_off and self.on_since):
            return None
        return (parse_iso(self.on_since) + self.auto_off).isoformat()

    def run_forever(self):
        while True:
            try:
                self.tick()
            except Exception as e:  # keep the scheduler alive no matter what
                log(f"scheduler error: {e}")
            time.sleep(SCHEDULER_INTERVAL)

    def next_run(self, now=None):
        now = now or datetime.now(timezone.utc)
        local = now.astimezone()
        candidates = [at for at in (parse_iso(t["at"]) for t in self.timers) if at > now]
        for w in self.weekly:
            if not w.get("enabled", True):
                continue
            hh, mm = map(int, w["time"].split(":"))
            for offset in range(8):
                day = local + timedelta(days=offset)
                slot = day.replace(hour=hh, minute=mm, second=0, microsecond=0)
                if day.weekday() in w["days"] and slot > local:
                    candidates.append(slot)
                    break
        return min(candidates).isoformat() if candidates else None

    def status(self):
        machine = {"state": "unavailable", "name": self.ha.entity}
        error = None
        try:
            machine = self.ha.state()
        except RuntimeError as e:
            error = str(e)
        local = datetime.now().astimezone()
        with self.lock:
            return {
                "configured": True,
                "entity": self.ha.entity,
                "name": machine["name"],
                "state": machine["state"],
                "error": error,
                "weekly": self.weekly,
                "timers": self.timers,
                "nextRun": self.next_run(),
                "lastEvent": self.last_event,
                "autoOffMinutes": int(self.auto_off.total_seconds() // 60) if self.auto_off else 0,
                "autoOffAt": self.auto_off_at() if machine["state"] == "on" else None,
                "serverTimeZone": local.tzname(),
                "serverUtcOffset": int(local.utcoffset().total_seconds() // 60),
            }


# ---------- HTTP ----------


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".js": "text/javascript",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, token, store, power, **kwargs):
        self.token = token
        self.store = store
        self.power = power
        super().__init__(*args, **kwargs)

    def end_headers(self):
        if self.path.startswith("/api/"):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Cache-Control", "no-store")
        else:
            # the service worker handles offline caching; always revalidate here
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        header = self.headers.get("Authorization", "")
        given = header[7:] if header.startswith("Bearer ") else ""
        return hmac.compare_digest(given.encode(), self.token.encode())

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            raise ValueError("invalid body size")
        data = json.loads(self.rfile.read(length))
        if not isinstance(data, dict):
            raise ValueError("expected a JSON object")
        return data

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if not self.path.startswith("/api/"):
            return super().do_GET()
        if not self.authorized():
            return self.send_json(401, {"error": "unauthorized"})
        if self.path == "/api/ping":
            return self.send_json(200, {"ok": True})
        if self.path == "/api/power":
            return self.send_json(200, self.power.status() if self.power else {"configured": False})
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in ("/api/sync", "/api/power", "/api/power/schedule"):
            return self.send_json(404, {"error": "not found"})
        if not self.authorized():
            return self.send_json(401, {"error": "unauthorized"})
        try:
            body = self.read_json()
        except ValueError as e:
            return self.send_json(400, {"error": f"invalid request: {e}"})

        if self.path == "/api/sync":
            return self.send_json(200, self.store.sync(body))

        if not self.power:
            return self.send_json(404, {"error": "machine power control is not configured on the server"})
        if self.path == "/api/power":
            if body.get("action") not in ("on", "off"):
                return self.send_json(400, {"error": "action must be 'on' or 'off'"})
            try:
                self.power.switch(body["action"] == "on", "app")
            except RuntimeError as e:
                return self.send_json(502, {"error": str(e)})
            return self.send_json(200, self.power.status())
        try:
            weekly, timers = clean_schedule(body)
        except (ValueError, TypeError) as e:
            return self.send_json(400, {"error": f"invalid schedule: {e}"})
        self.power.set_schedule(weekly, timers)
        self.send_json(200, self.power.status())


def load_token(data_dir):
    token = os.environ.get("SHOTLOG_TOKEN", "").strip()
    if token:
        return token
    token_file = data_dir / "token"
    if token_file.exists():
        return token_file.read_text().strip()
    token = secrets.token_urlsafe(24)
    token_file.parent.mkdir(parents=True, exist_ok=True)
    token_file.write_text(token + "\n")
    token_file.chmod(0o600)
    return token


def main():
    parser = argparse.ArgumentParser(description="Shot Log app + sync server")
    parser.add_argument("--host", default="0.0.0.0", help="interface to listen on (default: all)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    parser.add_argument("--data", default=str(ROOT / "data"), help="directory for the data file and token")
    parser.add_argument("--ha-url", default=os.environ.get("HA_URL", ""), help="Home Assistant URL, e.g. http://homeassistant.local:8123")
    parser.add_argument("--ha-token", default=os.environ.get("HA_TOKEN", ""), help="Home Assistant long-lived access token")
    parser.add_argument("--auto-off", type=int, default=int(os.environ.get("AUTO_OFF_MINUTES", 60)),
                        help="switch the machine off after this many minutes on (0 = never, default: 60)")
    parser.add_argument("--ha-entity", default=os.environ.get("HA_ENTITY", ""), help="entity to switch, e.g. switch.espresso_machine")
    args = parser.parse_args()

    data_dir = Path(args.data).resolve()
    token = load_token(data_dir)
    store = Store(data_dir / "shotlog.json")

    power = None
    if args.ha_url and args.ha_token and args.ha_entity:
        power = PowerScheduler(data_dir / "power.json", HomeAssistant(args.ha_url, args.ha_token, args.ha_entity),
                               auto_off_minutes=args.auto_off)
        threading.Thread(target=power.run_forever, daemon=True).start()
    elif args.ha_url or args.ha_token or args.ha_entity:
        log("machine power disabled: HA_URL, HA_TOKEN and HA_ENTITY must all be set")

    handler = partial(Handler, directory=str(PUBLIC_DIR), token=token, store=store, power=power)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Shot Log running on http://{args.host}:{args.port}", file=sys.stderr)
    print(f"Sync token: {token}", file=sys.stderr)
    print(f"Data file:  {store.path}", file=sys.stderr)
    print(f"Machine:    {args.ha_entity + ' via ' + args.ha_url if power else 'not configured'}", file=sys.stderr)
    if power:
        print(f"Auto-off:   {f'after {args.auto_off} min' if power.auto_off else 'disabled'}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
