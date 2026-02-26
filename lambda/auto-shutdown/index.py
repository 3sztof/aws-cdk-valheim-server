import os

import boto3
from aws_lambda_powertools import Logger, Metrics, Tracer
from aws_lambda_powertools.metrics import MetricUnit
from aws_lambda_powertools.utilities.typing import LambdaContext

from player_check import are_players_online

logger = Logger()
metrics = Metrics()
tracer = Tracer()

ec2 = boto3.client("ec2")

INSTANCE_ID = os.environ["INSTANCE_ID"]


@logger.inject_lambda_context(log_event=False)
@metrics.log_metrics(capture_cold_start_metric=True)
@tracer.capture_lambda_handler
def handler(event, context: LambdaContext):
    logger.info("Auto-shutdown triggered", extra={"instance_id": INSTANCE_ID})

    players_online = are_players_online()

    if players_online is None:
        # Could not determine player status - SSM unreachable, container not
        # running, or command timed out.
        # Safe default: SKIP the shutdown. If the container is genuinely down,
        # CPU will stay low and the alarm will fire again on the next evaluation
        # period. Better to leave the instance running than to kick active players.
        logger.warning(
            "Could not verify player count - skipping shutdown to avoid kicking active players",
            extra={"reason": "ssm_unreachable_or_check_failed"},
        )
        metrics.add_metric(
            name="AutoShutdownSkippedCheckFailed", unit=MetricUnit.Count, value=1
        )
        return {"statusCode": 200, "body": "Shutdown skipped - player check failed"}

    if players_online:
        logger.info("Shutdown skipped - players are connected")
        metrics.add_metric(
            name="AutoShutdownSkippedPlayersActive", unit=MetricUnit.Count, value=1
        )
        return {"statusCode": 200, "body": "Shutdown skipped - players active"}

    logger.info(
        "Server is idle - proceeding with shutdown", extra={"instance_id": INSTANCE_ID}
    )
    ec2.stop_instances(InstanceIds=[INSTANCE_ID])
    metrics.add_metric(
        name="AutoShutdownInstanceStopped", unit=MetricUnit.Count, value=1
    )
    return {"statusCode": 200, "body": "Instance stopped"}
