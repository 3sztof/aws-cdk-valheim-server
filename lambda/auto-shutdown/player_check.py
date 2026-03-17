import os
import time

import boto3
from aws_lambda_powertools import Logger, Tracer

logger = Logger()
tracer = Tracer()

ssm = boto3.client("ssm")

INSTANCE_ID = os.environ["INSTANCE_ID"]
CONTAINER_NAME = os.environ.get("CONTAINER_NAME", "valheim")

# How long to wait (seconds) for the SSM invocation result after the command
# is sent. valheim-is-idle takes ~4s (IDLE_DATAGRAM_WINDOW=3 + overhead) for
# crossplay/private servers; A2S query is near-instant for public servers.
# Allow generous headroom for SSM agent latency.
_SSM_POLL_INTERVAL = 2
_SSM_POLL_MAX_ATTEMPTS = 15  # 30s total

# Kept for metrics / logging context - matches container defaults.
IDLE_DATAGRAM_WINDOW = 3
IDLE_DATAGRAM_MAX_COUNT = 30


@tracer.capture_method
def are_players_online() -> bool | None:
    """
    Ask the container whether players are connected using the container's own
    ``valheim-is-idle`` script.

    The script handles crossplay vs. non-crossplay automatically:
    - crossplay / private: nstat UDP datagram counting (IDLE_DATAGRAM_WINDOW,
      IDLE_DATAGRAM_MAX_COUNT) inside the container's network namespace
    - public non-crossplay: A2S query against the Steam query port (reliable)

    Exit codes from valheim-is-idle:
        0  → server is idle   (no players)
        1  → players connected

    Returns:
        True   - players are online, do NOT stop
        False  - server is idle, safe to stop
        None   - check could not be completed (SSM unreachable, container not
                 running, command timed out).  Callers MUST treat None as
                 "unknown - skip the stop" to avoid kicking active players.
    """
    # Run valheim-is-idle inside the container so it uses the container's
    # network namespace and environment variables (IDLE_DATAGRAM_WINDOW etc.).
    cmd = f'docker exec {CONTAINER_NAME} valheim-is-idle; echo "exit:$?"'

    try:
        result = ssm.send_command(
            InstanceIds=[INSTANCE_ID],
            DocumentName="AWS-RunShellScript",
            Parameters={"commands": [cmd]},
            TimeoutSeconds=45,
        )
        command_id = result["Command"]["CommandId"]

        for attempt in range(_SSM_POLL_MAX_ATTEMPTS):
            time.sleep(_SSM_POLL_INTERVAL)
            inv = ssm.get_command_invocation(
                CommandId=command_id,
                InstanceId=INSTANCE_ID,
            )
            status = inv["Status"]
            if status not in ("Success", "Failed", "Cancelled", "TimedOut"):
                logger.debug(
                    "Waiting for SSM invocation",
                    extra={"attempt": attempt + 1, "ssm_status": status},
                )
                continue

            # Command finished (success or failure at OS level)
            raw_out = inv.get("StandardOutputContent", "").strip()
            raw_err = inv.get("StandardErrorContent", "").strip()

            # Parse "exit:<code>" we appended so we get the exit code even
            # when SSM reports the wrapper as "Success".
            exit_code = None
            for line in reversed(raw_out.splitlines()):
                if line.startswith("exit:"):
                    try:
                        exit_code = int(line.split(":", 1)[1])
                    except ValueError:
                        pass
                    break

            if status != "Success" or exit_code is None:
                logger.warning(
                    "Player check command failed or exit code missing",
                    extra={
                        "ssm_status": status,
                        "exit_code": exit_code,
                        "stdout": raw_out[:500],
                        "stderr": raw_err[:200],
                    },
                )
                return None

            # valheim-is-idle: 0 = idle, 1 = players connected
            # Any other exit code (e.g. 127 = container not found, 126 = exec
            # failed) is treated as unknown.
            if exit_code == 0:
                logger.info(
                    "Player check: server is idle", extra={"exit_code": exit_code}
                )
                return False
            elif exit_code == 1:
                logger.info(
                    "Player check: players are online", extra={"exit_code": exit_code}
                )
                return True
            else:
                logger.warning(
                    "Player check returned unexpected exit code - treating as unknown",
                    extra={
                        "exit_code": exit_code,
                        "stdout": raw_out[:500],
                        "stderr": raw_err[:200],
                    },
                )
                return None

        logger.warning(
            "Player check timed out waiting for SSM invocation result",
            extra={"max_attempts": _SSM_POLL_MAX_ATTEMPTS},
        )
        return None

    except Exception as e:
        logger.warning("Player check failed with exception", exc_info=e)
        return None
