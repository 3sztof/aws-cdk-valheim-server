import boto3
import json
import os
import urllib.request

ec2 = boto3.client('ec2')
ssm = boto3.client('ssm')

INSTANCE_ID = os.environ['INSTANCE_ID']
DISCORD_WEBHOOK_PARAM = os.environ.get('DISCORD_WEBHOOK_PARAM', '')
NOTIFY_ON_START = os.environ.get('NOTIFY_ON_START', 'false') == 'true'
NOTIFY_ON_STOP = os.environ.get('NOTIFY_ON_STOP', 'false') == 'true'


def send_discord_notification(message, color=3447003):
    if not DISCORD_WEBHOOK_PARAM:
        return

    try:
        webhook_url = ssm.get_parameter(
            Name=DISCORD_WEBHOOK_PARAM,
            WithDecryption=True
        )['Parameter']['Value']

        payload = {
            'embeds': [{
                'title': 'Valheim Server',
                'description': message,
                'color': color
            }]
        }

        req = urllib.request.Request(
            webhook_url,
            data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        urllib.request.urlopen(req)
    except Exception as e:
        print(f'Discord notification failed: {e}')


def get_instance_status():
    response = ec2.describe_instances(InstanceIds=[INSTANCE_ID])
    instance = response['Reservations'][0]['Instances'][0]
    state = instance['State']['Name']
    public_ip = instance.get('PublicIpAddress', 'N/A')
    return {'state': state, 'publicIp': public_ip, 'instanceId': INSTANCE_ID}


def handler(event, context):
    path = event.get('path', '')
    method = event.get('httpMethod', '')

    try:
        if '/start' in path and method == 'POST':
            ec2.start_instances(InstanceIds=[INSTANCE_ID])
            if NOTIFY_ON_START:
                send_discord_notification('Server is starting...', 3066993)
            return response(200, {'message': 'Server starting', 'instanceId': INSTANCE_ID})

        elif '/stop' in path and method == 'POST':
            ec2.stop_instances(InstanceIds=[INSTANCE_ID])
            if NOTIFY_ON_STOP:
                send_discord_notification('Server is stopping...', 15158332)
            return response(200, {'message': 'Server stopping', 'instanceId': INSTANCE_ID})

        elif '/status' in path and method == 'GET':
            status = get_instance_status()
            return response(200, status)

        else:
            return response(400, {'error': 'Unknown action'})

    except Exception as e:
        return response(500, {'error': str(e)})


def response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        'body': json.dumps(body)
    }
