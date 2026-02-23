import boto3
import json
import os
import urllib.request

ec2 = boto3.client("ec2")
ssm = boto3.client("ssm")

INSTANCE_ID = os.environ["INSTANCE_ID"]
DISCORD_WEBHOOK_PARAM = os.environ.get("DISCORD_WEBHOOK_PARAM", "")
NOTIFY_ON_START = os.environ.get("NOTIFY_ON_START", "false") == "true"
NOTIFY_ON_STOP = os.environ.get("NOTIFY_ON_STOP", "false") == "true"

LOG_LINES = 30
SSM_LOG_TIMEOUT = 20


def send_discord_notification(message, color=3447003):
    if not DISCORD_WEBHOOK_PARAM:
        return

    try:
        webhook_url = ssm.get_parameter(
            Name=DISCORD_WEBHOOK_PARAM, WithDecryption=True
        )["Parameter"]["Value"]

        payload = {
            "embeds": [
                {"title": "Valheim Server", "description": message, "color": color}
            ]
        }

        req = urllib.request.Request(
            webhook_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req)
    except Exception as e:
        print(f"Discord notification failed: {e}")


def get_instance_status():
    resp = ec2.describe_instances(InstanceIds=[INSTANCE_ID])
    instance = resp["Reservations"][0]["Instances"][0]
    state = instance["State"]["Name"]
    public_ip = instance.get("PublicIpAddress", "N/A")
    return {"state": state, "publicIp": public_ip, "instanceId": INSTANCE_ID}


def get_recent_logs():
    """Fetch the last LOG_LINES lines from the Valheim Docker container via SSM.
    Returns a list of log lines, or None if the instance is not running / SSM times out.
    The logs contain only game events (player joins, saves, raids) - no credentials or secrets.
    """
    try:
        cmd = ssm.send_command(
            InstanceIds=[INSTANCE_ID],
            DocumentName="AWS-RunShellScript",
            Parameters={"commands": [f"docker logs --tail {LOG_LINES} valheim 2>&1"]},
            TimeoutSeconds=SSM_LOG_TIMEOUT,
        )
        command_id = cmd["Command"]["CommandId"]

        import time

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
                    lines = [l for l in raw.splitlines() if l.strip()]
                    return lines
                return None
        return None
    except Exception as e:
        print(f"Log fetch failed: {e}")
        return None


def handler(event, context):
    path = event.get("path", "")
    method = event.get("httpMethod", "")

    try:
        if "/start" in path and method == "GET":
            ec2.start_instances(InstanceIds=[INSTANCE_ID])
            if NOTIFY_ON_START:
                send_discord_notification("Server is starting...", 3066993)
            return response(
                200, {"message": "Server starting", "instanceId": INSTANCE_ID}
            )

        elif "/stop" in path and method == "GET":
            ec2.stop_instances(InstanceIds=[INSTANCE_ID])
            if NOTIFY_ON_STOP:
                send_discord_notification("Server is stopping...", 15158332)
            return response(
                200, {"message": "Server stopping", "instanceId": INSTANCE_ID}
            )

        elif "/status" in path and method == "GET":
            status = get_instance_status()
            if status["state"] == "running":
                logs = get_recent_logs()
                if logs is not None:
                    status["recentLogs"] = logs
            return response(200, status)

        else:
            return response(400, {"error": "Unknown action"})

    except Exception as e:
        return response(500, {"error": str(e)})


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(body),
    }
