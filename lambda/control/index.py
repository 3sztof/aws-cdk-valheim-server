import json
import os
import urllib.request

import boto3
from aws_lambda_powertools import Logger, Metrics, Tracer
from aws_lambda_powertools.metrics import MetricUnit
from aws_lambda_powertools.utilities.typing import LambdaContext

from player_check import are_players_online

logger = Logger()
metrics = Metrics()
tracer = Tracer()

ec2 = boto3.client("ec2")
ssm = boto3.client("ssm")

INSTANCE_ID = os.environ["INSTANCE_ID"]
DISCORD_WEBHOOK_PARAM = os.environ.get("DISCORD_WEBHOOK_PARAM", "")
NOTIFY_ON_START = os.environ.get("NOTIFY_ON_START", "false") == "true"
NOTIFY_ON_STOP = os.environ.get("NOTIFY_ON_STOP", "false") == "true"
CONTROL_BASE_URL = os.environ.get(
    "CONTROL_BASE_URL", ""
)  # e.g. https://example.com/server/
CONTAINER_NAME = os.environ.get("CONTAINER_NAME", "valheim")

LOG_LINES = 30
SSM_LOG_TIMEOUT = 30

# ---------------------------------------------------------------------------
# HTML helpers
# ---------------------------------------------------------------------------

_HTML_BASE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CONTAINER_NAME_PLACEHOLDER - {title}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=MedievalSharp&family=Cinzel:wght@400;600&family=Inter:wght@400;500&display=swap');
  *{{box-sizing:border-box;margin:0;padding:0}}
  :root{{
    --bg:#0d0f0e;--surface:#161a18;--surface2:#1e2420;
    --border:#2a3330;--text:#c8d8c0;--muted:#6b7c6b;
    --green:#4caf7d;--red:#e05c5c;--yellow:#d4a843;--blue:#5b9bd5;
    --green-dim:#1a3326;--red-dim:#2e1a1a;--yellow-dim:#2e2510;
  }}
  body{{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:2rem 1rem}}
  .card{{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:2rem;max-width:640px;width:100%;margin-top:1.5rem}}
  h1{{font-family:'Cinzel',serif;font-size:1.5rem;font-weight:600;letter-spacing:.05em;margin-bottom:.25rem}}
  .subtitle{{color:var(--muted);font-size:.875rem;margin-bottom:1.5rem}}
  .badge{{display:inline-flex;align-items:center;gap:.4rem;padding:.3rem .75rem;border-radius:99px;font-size:.8rem;font-weight:500;letter-spacing:.03em}}
  .badge-green{{background:var(--green-dim);color:var(--green);border:1px solid var(--green)}}
  .badge-red{{background:var(--red-dim);color:var(--red);border:1px solid var(--red)}}
  .badge-yellow{{background:var(--yellow-dim);color:var(--yellow);border:1px solid var(--yellow)}}
  .badge-blue{{background:#0d1e2e;color:var(--blue);border:1px solid var(--blue)}}
  .info-grid{{display:grid;grid-template-columns:auto 1fr;gap:.5rem 1.25rem;margin:1.25rem 0;font-size:.9rem}}
  .info-grid dt{{color:var(--muted)}}
  .info-grid dd{{font-family:monospace;font-size:.85rem}}
  .btn{{display:inline-flex;align-items:center;gap:.5rem;padding:.6rem 1.25rem;border-radius:8px;font-size:.875rem;font-weight:500;text-decoration:none;border:none;cursor:pointer;transition:opacity .15s}}
  .btn:hover{{opacity:.85}}
  .btn-green{{background:var(--green);color:#0d0f0e}}
  .btn-red{{background:var(--red);color:#fff}}
  .btn-muted{{background:var(--surface2);color:var(--text);border:1px solid var(--border)}}
  .actions{{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.25rem}}
  .logs{{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:1rem;margin-top:1.25rem;max-height:320px;overflow-y:auto}}
  .logs-title{{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:.75rem}}
  .log-line{{font-family:monospace;font-size:.75rem;line-height:1.6;color:#a0b49a;white-space:pre-wrap;word-break:break-all}}
  .log-line.join{{color:var(--green)}}
  .log-line.death{{color:var(--red)}}
  .log-line.raid{{color:var(--yellow)}}
  .log-line.save{{color:var(--blue)}}
  .divider{{border:none;border-top:1px solid var(--border);margin:1.25rem 0}}
  .notice{{font-size:.875rem;color:var(--muted);line-height:1.6}}
  .notice strong{{color:var(--text)}}
  .viking{{font-size:3rem;margin-bottom:.5rem;display:block;text-align:center}}
  .container-row{{display:flex;align-items:center;gap:.75rem;margin-top:.5rem}}
  .hint{{font-size:.75rem;color:var(--muted);font-style:italic;margin-top:.25rem}}
</style>
</head>
<body>
<span class="viking">{viking}</span>
<div class="card">{body}</div>
<script>
function confirmAction(msg) {{
  return window.confirm(msg);
}}
</script>
</body>
</html>"""
# Substitute the container name into the template once at module load so all
# .format(title=...) calls get the right name without needing an extra kwarg.
_HTML_BASE = _HTML_BASE.replace("CONTAINER_NAME_PLACEHOLDER", CONTAINER_NAME)


def _classify_log(line):
    lower_line = line.lower()
    if "zdoid from" in lower_line and ": 0:0" in lower_line:
        return "death"
    if "zdoid from" in lower_line:
        return "join"
    if "random event" in lower_line or "raid" in lower_line:
        return "raid"
    if "world saved" in lower_line or "saving" in lower_line:
        return "save"
    return ""


def _render_logs_html(lines):
    if not lines:
        return ""
    items = ""
    for line in lines[-20:]:
        cls = _classify_log(line)
        escaped = line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        items += f'<div class="log-line {cls}">{escaped}</div>\n'
    return f'<div class="logs"><div class="logs-title">Recent {CONTAINER_NAME} log</div>{items}</div>'


def _base_url():
    return CONTROL_BASE_URL or ""


def _container_badge_html(container_status):
    """Render a small badge for the Valheim container state."""
    if container_status is None:
        return '<span class="badge badge-yellow">&#9679; Container unknown</span>'
    state = container_status.get("state", "unknown").lower()
    health = container_status.get("health", "")
    if state == "running":
        if health == "healthy":
            label = "Container healthy"
            cls = "badge-green"
        elif health == "starting":
            label = "Container starting"
            cls = "badge-yellow"
        elif health == "unhealthy":
            label = "Container unhealthy"
            cls = "badge-red"
        else:
            label = "Container running"
            cls = "badge-blue"
    elif state in ("exited", "dead"):
        label = f"Container {state}"
        cls = "badge-red"
    elif state == "created":
        label = "Container created"
        cls = "badge-yellow"
    else:
        label = f"Container {state}"
        cls = "badge-yellow"
    return f'<span class="badge {cls}">&#9679; {label}</span>'


def html_start_page(action_taken):
    stop_url = _base_url() + "stop"
    status_url = _base_url() + "status"
    body = f"""
<h1>Server Starting</h1>
<p class="subtitle">The EC2 instance is booting up.</p>
<span class="badge badge-yellow">&#9654; EC2 Starting</span>
<hr class="divider">
<p class="notice">The <strong>EC2 instance</strong> is starting. The game server container will launch
automatically once the instance is online &mdash; this usually takes <strong>2-3 minutes</strong>
before the game server is joinable.</p>
<div class="actions">
  <a class="btn btn-muted" href="{status_url}">&#128269; Status</a>
  <a class="btn btn-red" href="{stop_url}" onclick="return confirmAction('Stop the EC2 instance? Players will be disconnected.')">&#9209; Stop</a>
</div>"""
    return _HTML_BASE.format(title="Starting", viking="&#9876;", body=body)


def html_stop_page():
    start_url = _base_url() + "start"
    status_url = _base_url() + "status"
    body = f"""
<h1>Server Stopping</h1>
<p class="subtitle">The EC2 instance is shutting down.</p>
<span class="badge badge-red">&#9209; EC2 Stopping</span>
<hr class="divider">
<p class="notice">The game server container saves the world before the <strong>EC2 instance</strong>
shuts down. It may take up to a minute to fully stop.</p>
<div class="actions">
  <a class="btn btn-green" href="{start_url}" onclick="return confirmAction('Start the EC2 instance and launch the game server?')">&#9654; Start</a>
  <a class="btn btn-muted" href="{status_url}">&#128269; Status</a>
</div>"""
    return _HTML_BASE.format(title="Stopping", viking="&#128128;", body=body)


def html_players_active_page():
    status_url = _base_url() + "status"
    body = f"""
<h1>Stop Rejected</h1>
<p class="subtitle">Players are currently connected.</p>
<span class="badge badge-green">&#9679; Players Online</span>
<hr class="divider">
<p class="notice">The server cannot be stopped while players are connected.<br>
Wait for everyone to disconnect, then try again.</p>
<div class="actions">
  <a class="btn btn-muted" href="{status_url}">&#128269; Status</a>
</div>"""
    return _HTML_BASE.format(title="Stop Rejected", viking="&#9876;", body=body)


def html_player_check_failed_page():
    status_url = _base_url() + "status"
    stop_url = _base_url() + "stop"
    body = f"""
<h1>Stop Unavailable</h1>
<p class="subtitle">Could not verify player status.</p>
<span class="badge badge-yellow">&#9888; Check Failed</span>
<hr class="divider">
<p class="notice">The player check could not be completed (the instance may be
unreachable via SSM or the game server container is not running).<br><br>
To protect active players, the stop was <strong>rejected</strong>.<br>
Check the status page, then try again in a moment.</p>
<div class="actions">
  <a class="btn btn-muted" href="{status_url}">&#128269; Status</a>
  <a class="btn btn-red" href="{stop_url}" onclick="return confirmAction('The player check failed. Stop anyway? Active players will be disconnected.')">&#9209; Force Stop</a>
</div>"""
    return _HTML_BASE.format(title="Stop Unavailable", viking="&#9785;", body=body)


def html_status_page(status, logs, container_status):
    state = status["state"]
    public_ip = status.get("publicIp", "N/A")
    start_url = _base_url() + "start"
    stop_url = _base_url() + "stop"
    status_url = _base_url() + "status"

    if state == "running":
        ec2_badge = '<span class="badge badge-green">&#9679; EC2 Online</span>'
        viking = "&#9876;"
        connect = (
            f"<dd><strong>{public_ip}:2456</strong></dd>"
            if public_ip != "N/A"
            else "<dd>N/A</dd>"
        )
        actions = f"""
  <a class="btn btn-muted" href="{status_url}">&#8635; Refresh</a>
  <a class="btn btn-red" href="{stop_url}" onclick="return confirmAction('Stop the EC2 instance? Active players will be disconnected and the game server will shut down.')">&#9209; Stop EC2</a>"""
    elif state == "stopped":
        ec2_badge = '<span class="badge badge-red">&#9679; EC2 Offline</span>'
        viking = "&#128128;"
        connect = "<dd>Server is offline</dd>"
        actions = f"""
  <a class="btn btn-green" href="{start_url}" onclick="return confirmAction('Start the EC2 instance? The game server will launch automatically after boot (~2-3 min).')">&#9654; Start EC2</a>
  <a class="btn btn-muted" href="{status_url}">&#8635; Refresh</a>"""
    else:
        ec2_badge = (
            '<span class="badge badge-yellow">&#9679; EC2 {state}</span>'.format(
                state=state.capitalize()
            )
        )
        viking = "&#8987;"
        connect = f"<dd>{state}</dd>"
        actions = f'<a class="btn btn-muted" href="{status_url}">&#8635; Refresh</a>'

    container_badge_html = (
        _container_badge_html(container_status) if state == "running" else ""
    )
    container_hint = (
        '<p class="hint">&#9432; Status reflects the EC2 instance. '
        "The game server container may take additional time to become ready after the instance starts.</p>"
        if state != "stopped"
        else ""
    )

    logs_html = _render_logs_html(logs) if logs else ""

    body = f"""
<h1>{CONTAINER_NAME}</h1>
<p class="subtitle">Status and controls</p>
{ec2_badge}
{"&nbsp;" + container_badge_html if container_badge_html else ""}
{container_hint}
<dl class="info-grid">
  <dt>EC2 State</dt><dd>{state}</dd>
  <dt>Connect</dt>{connect}
  <dt>Instance</dt><dd>{INSTANCE_ID}</dd>"""

    if container_status and state == "running":
        c_state = container_status.get("state", "unknown")
        c_health = container_status.get("health", "")
        c_started = container_status.get("startedAt", "")
        body += f"""
  <dt>Container</dt><dd>{c_state}{(" / " + c_health) if c_health else ""}</dd>"""
        if c_started:
            body += f"""
  <dt>Started at</dt><dd>{c_started}</dd>"""

    body += f"""
</dl>
<hr class="divider">
<div class="actions">{actions}
</div>
{logs_html}"""
    return _HTML_BASE.format(title="Status", viking=viking, body=body)


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------


def wants_html(event):
    headers = event.get("headers") or {}
    accept = headers.get("Accept") or headers.get("accept") or ""
    return "text/html" in accept


@tracer.capture_method
def send_discord_notification(message, color=3447003):
    if not DISCORD_WEBHOOK_PARAM:
        return

    try:
        webhook_url = ssm.get_parameter(
            Name=DISCORD_WEBHOOK_PARAM, WithDecryption=True
        )["Parameter"]["Value"]

        payload = {
            "embeds": [
                {"title": CONTAINER_NAME, "description": message, "color": color}
            ]
        }

        req = urllib.request.Request(
            webhook_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req)
    except Exception as e:
        logger.warning("Discord notification failed", exc_info=e)


@tracer.capture_method
def get_instance_status():
    resp = ec2.describe_instances(InstanceIds=[INSTANCE_ID])
    instance = resp["Reservations"][0]["Instances"][0]
    state = instance["State"]["Name"]
    public_ip = instance.get("PublicIpAddress", "N/A")
    return {"state": state, "publicIp": public_ip, "instanceId": INSTANCE_ID}


@tracer.capture_method
def get_container_status():
    """
    Fetch Valheim container state and health via SSM docker inspect.

    Returns a dict with keys: state, health (if available), startedAt.
    Returns None if the instance is not running or SSM times out.
    """
    import time

    cmd = (
        f"docker inspect {CONTAINER_NAME} "
        "--format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.StartedAt}}' "
        "2>/dev/null || echo 'notfound||'"
    )

    try:
        result = ssm.send_command(
            InstanceIds=[INSTANCE_ID],
            DocumentName="AWS-RunShellScript",
            Parameters={"commands": [cmd]},
            TimeoutSeconds=SSM_LOG_TIMEOUT,
        )
        command_id = result["Command"]["CommandId"]

        for _ in range(8):
            time.sleep(2)
            inv = ssm.get_command_invocation(
                CommandId=command_id,
                InstanceId=INSTANCE_ID,
            )
            inv_status = inv["Status"]
            if inv_status in ("Success", "Failed", "Cancelled", "TimedOut"):
                if inv_status != "Success":
                    logger.warning(
                        "Container status command failed",
                        extra={"ssm_status": inv_status},
                    )
                    return None
                raw = inv.get("StandardOutputContent", "").strip()
                parts = raw.split("|", 2)
                container_state = parts[0].strip() if len(parts) > 0 else "unknown"
                health = parts[1].strip() if len(parts) > 1 else ""
                started_at = parts[2].strip() if len(parts) > 2 else ""
                if container_state == "notfound":
                    logger.info("Valheim container not found on instance")
                    return {"state": "not found", "health": "", "startedAt": ""}
                logger.info(
                    "Container status retrieved",
                    extra={
                        "container_state": container_state,
                        "health": health,
                        "started_at": started_at,
                    },
                )
                return {
                    "state": container_state,
                    "health": health,
                    "startedAt": started_at,
                }
        logger.warning("Container status check timed out waiting for SSM result")
        return None
    except Exception as e:
        logger.warning("Container status fetch failed", exc_info=e)
        return None


@tracer.capture_method
def get_recent_logs():
    """Fetch the last LOG_LINES lines from the Valheim Docker container via SSM.
    Returns a list of log lines, or None if the instance is not running / SSM times out.
    The logs contain only game events (player joins, saves, raids) - no credentials or secrets.
    """
    import time

    try:
        cmd = ssm.send_command(
            InstanceIds=[INSTANCE_ID],
            DocumentName="AWS-RunShellScript",
            Parameters={
                "commands": [f"docker logs --tail {LOG_LINES} {CONTAINER_NAME} 2>&1"]
            },
            TimeoutSeconds=SSM_LOG_TIMEOUT,
        )
        command_id = cmd["Command"]["CommandId"]

        for _ in range(8):
            time.sleep(2)
            result = ssm.get_command_invocation(
                CommandId=command_id,
                InstanceId=INSTANCE_ID,
            )
            status = result["Status"]
            if status in ("Success", "Failed", "Cancelled", "TimedOut"):
                if status == "Success":
                    raw = result.get("StandardOutputContent", "")
                    lines = [ln for ln in raw.splitlines() if ln.strip()]
                    logger.info(
                        "Fetched container logs", extra={"line_count": len(lines)}
                    )
                    return lines
                logger.warning("Log fetch command failed", extra={"ssm_status": status})
                return None
        logger.warning("Log fetch timed out waiting for SSM result")
        return None
    except Exception as e:
        logger.warning("Log fetch failed", exc_info=e)
        return None


@logger.inject_lambda_context(log_event=False)
@metrics.log_metrics(capture_cold_start_metric=True)
@tracer.capture_lambda_handler
def handler(event, context: LambdaContext):
    path = event.get("path", "")
    method = event.get("httpMethod", "")
    browser = wants_html(event)

    logger.append_keys(path=path, method=method, browser=browser)
    logger.info("Request received")

    try:
        if "/start" in path and method == "GET":
            return _handle_start(browser)

        elif "/stop" in path and method == "GET":
            return _handle_stop(browser)

        elif "/status" in path and method == "GET":
            return _handle_status(browser)

        else:
            logger.warning("Unknown action requested", extra={"path": path})
            if browser:
                return html_response(400, "<p>Unknown action.</p>")
            return json_response(400, {"error": "Unknown action"})

    except Exception as e:
        logger.exception("Unhandled error in handler")
        metrics.add_metric(name="HandlerError", unit=MetricUnit.Count, value=1)
        if browser:
            return html_response(500, f"<p>Error: {e}</p>")
        return json_response(500, {"error": str(e)})


@tracer.capture_method
def _handle_start(browser):
    logger.info("Starting EC2 instance", extra={"instance_id": INSTANCE_ID})
    ec2.start_instances(InstanceIds=[INSTANCE_ID])
    metrics.add_metric(name="InstanceStarted", unit=MetricUnit.Count, value=1)
    if NOTIFY_ON_START:
        msg = "Server is starting..."
        if CONTROL_BASE_URL:
            msg += (
                f"\n\n**Control links**"
                f"\nStart: {CONTROL_BASE_URL}start"
                f"\nStop: {CONTROL_BASE_URL}stop"
                f"\nStatus: {CONTROL_BASE_URL}status"
            )
        send_discord_notification(msg, 3066993)
    if browser:
        return html_response(200, html_start_page(True))
    return json_response(200, {"message": "Server starting", "instanceId": INSTANCE_ID})


@tracer.capture_method
def _handle_stop(browser):
    players_online = are_players_online()

    if players_online is None:
        # Check failed (SSM unreachable, container not running, timeout, etc.).
        # Safe default: refuse the stop - we cannot confirm no one is playing.
        logger.warning(
            "Stop rejected - could not verify player count; refusing to stop to avoid kicking players"
        )
        metrics.add_metric(
            name="StopRejectedCheckFailed", unit=MetricUnit.Count, value=1
        )
        if browser:
            return html_response(
                503,
                html_player_check_failed_page(),
            )
        return json_response(
            503,
            {
                "error": "Could not verify player count - stop rejected to avoid kicking active players",
                "retryable": True,
            },
        )

    if players_online:
        logger.info("Stop rejected - players are connected")
        metrics.add_metric(
            name="StopRejectedPlayersActive", unit=MetricUnit.Count, value=1
        )
        if browser:
            return html_response(409, html_players_active_page())
        return json_response(409, {"error": "Players are connected"})

    logger.info("Stopping EC2 instance", extra={"instance_id": INSTANCE_ID})
    ec2.stop_instances(InstanceIds=[INSTANCE_ID])
    metrics.add_metric(name="InstanceStopped", unit=MetricUnit.Count, value=1)
    if NOTIFY_ON_STOP:
        send_discord_notification("Server is stopping...", 15158332)
    if browser:
        return html_response(200, html_stop_page())
    return json_response(200, {"message": "Server stopping", "instanceId": INSTANCE_ID})


@tracer.capture_method
def _handle_status(browser):
    status = get_instance_status()
    instance_state = status["state"]
    logs = None
    container_status = None

    if instance_state == "running":
        # Fetch logs and container status in parallel is not worth the complexity here
        # (SSM commands are sequential anyway). Fetch both sequentially.
        logs = get_recent_logs()
        if logs is not None:
            status["recentLogs"] = logs
        container_status = get_container_status()
        if container_status is not None:
            status["container"] = container_status

    if CONTROL_BASE_URL:
        status["controlLinks"] = {
            "start": f"{CONTROL_BASE_URL}start",
            "stop": f"{CONTROL_BASE_URL}stop",
            "status": f"{CONTROL_BASE_URL}status",
        }

    logger.info(
        "Status retrieved",
        extra={
            "instance_state": instance_state,
            "has_logs": logs is not None,
            "container_state": (container_status or {}).get("state"),
            "container_health": (container_status or {}).get("health"),
        },
    )
    metrics.add_metric(name="StatusChecked", unit=MetricUnit.Count, value=1)

    if browser:
        return html_response(200, html_status_page(status, logs, container_status))
    return json_response(200, status)


def html_response(status_code, body_html):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "text/html; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
        },
        "body": body_html,
    }


def json_response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(body),
    }
