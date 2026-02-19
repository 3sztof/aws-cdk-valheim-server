import boto3
import os

ec2 = boto3.client('ec2')
INSTANCE_ID = os.environ['INSTANCE_ID']


def handler(event, context):
    print(f'Stopping instance {INSTANCE_ID} due to idle timeout')
    ec2.stop_instances(InstanceIds=[INSTANCE_ID])
    return {'statusCode': 200, 'body': 'Instance stopped'}
