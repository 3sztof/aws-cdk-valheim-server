#!/bin/bash
set -euo pipefail

exec > >(tee /var/log/userdata.log) 2>&1
echo "Starting Valheim server setup at $(date)"

export VALHEIM_SERVER_NAME="${SERVER_NAME}"
export VALHEIM_WORLD="${WORLD_NAME}"
export VALHEIM_PASSWORD="${SERVER_PASSWORD}"
export VALHEIM_PUBLIC="${SERVER_PUBLIC}"
export VALHEIM_CROSSPLAY="${CROSSPLAY}"
export ADMINLIST_IDS="${ADMIN_STEAM_IDS}"
export BANNEDLIST_IDS="${BANNED_STEAM_IDS}"
export PERMITTEDLIST_IDS="${PERMITTED_STEAM_IDS}"
export S3_BACKUP_BUCKET="${BACKUP_BUCKET}"
export DISCORD_WEBHOOK_PARAM="${DISCORD_WEBHOOK_PARAM}"
export BACKUP_CRON="${BACKUP_CRON}"

dnf update -y
dnf install -y docker jq

systemctl enable docker
systemctl start docker

mkdir -p /opt/valheim/server
mkdir -p /opt/valheim/saves
mkdir -p /opt/valheim/backups
mkdir -p /opt/valheim/scripts

# Fetch Discord webhook URL from SSM (if configured)
DISCORD_WEBHOOK_URL=""
if [ -n "${DISCORD_WEBHOOK_PARAM:-}" ]; then
    DISCORD_WEBHOOK_URL=$(aws ssm get-parameter --name "$DISCORD_WEBHOOK_PARAM" --with-decryption --query 'Parameter.Value' --output text 2>/dev/null || echo "")
fi

TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "unknown")

# Write env file for host-level scripts (restore, etc.)
cat > /opt/valheim/env.sh << ENVFILE
export S3_BACKUP_BUCKET="${BACKUP_BUCKET}"
export DISCORD_WEBHOOK_PARAM="${DISCORD_WEBHOOK_PARAM}"
export VALHEIM_SERVER_NAME="${SERVER_NAME}"
ENVFILE

# Write valheim.env - ALL container env vars go here
# Using docker run --env-file (not docker-compose env_file) to avoid
# docker-compose's template interpolation of ${} in hook commands.
cat > /opt/valheim/valheim.env << ENVEOF
SERVER_NAME=${VALHEIM_SERVER_NAME}
WORLD_NAME=${VALHEIM_WORLD}
SERVER_PASS=${VALHEIM_PASSWORD}
SERVER_PUBLIC=${VALHEIM_PUBLIC}
ADMINLIST_IDS=${ADMINLIST_IDS}
BANNEDLIST_IDS=${BANNEDLIST_IDS}
PERMITTEDLIST_IDS=${PERMITTEDLIST_IDS}
UPDATE_IF_IDLE=true
BACKUPS=true
BACKUPS_CRON=${BACKUP_CRON}
BACKUPS_DIRECTORY=/config/backups
BACKUPS_MAX_AGE=7
BACKUPS_MAX_COUNT=0
BACKUPS_IF_IDLE=true
BACKUPS_ZIP=true
POST_BOOTSTRAP_HOOK=apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y install awscli
POST_BACKUP_HOOK=aws s3 cp @BACKUP_FILE@ s3://${S3_BACKUP_BUCKET}/backups/
DISCORD_WEBHOOK=${DISCORD_WEBHOOK_URL}
POST_SERVER_LISTENING_HOOK=curl -sfSL -X POST -H "Content-Type: application/json" -d '{"username":"Valheim","embeds":[{"title":"Server Online","description":"Valheim server is ready!\\nConnect to: ${PUBLIC_IP}:2456","color":3066993}]}' "\$DISCORD_WEBHOOK" 2>/dev/null || true
PRE_SERVER_SHUTDOWN_HOOK=curl -sfSL -X POST -H "Content-Type: application/json" -d '{"username":"Valheim","embeds":[{"title":"Server Offline","description":"Valheim server (${PUBLIC_IP}) is shutting down.","color":15158332}]}' "\$DISCORD_WEBHOOK" 2>/dev/null || true
VALHEIM_LOG_FILTER_CONTAINS_Spawned=Got character ZDOID from
ON_VALHEIM_LOG_FILTER_CONTAINS_Spawned={ read l; if echo "\$l" | grep -q ": 0:0"; then name=\${l//*ZDOID from /}; name=\${name// :*/}; msg="\xF0\x9F\x92\x80 \$name died"; else name=\${l//*ZDOID from /}; name=\${name// :*/}; msg="\xE2\x9A\x94 \$name joined the server"; fi; curl -sfSL -X POST -H "Content-Type: application/json" -d "{\"username\":\"Valheim\",\"content\":\"\$msg\"}" "\$DISCORD_WEBHOOK" 2>/dev/null; }
VALHEIM_LOG_FILTER_CONTAINS_Raid=Random event set:
ON_VALHEIM_LOG_FILTER_CONTAINS_Raid={ read l; event=\${l//*Random event set:/}; event=\${event%% *}; curl -sfSL -X POST -H "Content-Type: application/json" -d "{\"username\":\"Valheim\",\"embeds\":[{\"title\":\"\xF0\x9F\x9A\xA8 Raid!\",\"description\":\"Event: \$event\",\"color\":15158332}]}" "\$DISCORD_WEBHOOK" 2>/dev/null; }
ENVEOF

cat > /opt/valheim/start.sh << 'STARTSH'
#!/bin/bash
docker rm -f valheim 2>/dev/null || true
exec docker run -d \
  --name valheim \
  --cap-add=sys_nice \
  --stop-timeout 120 \
  --restart unless-stopped \
  -p 2456-2457:2456-2457/udp \
  --env-file /opt/valheim/valheim.env \
  -v /opt/valheim/server:/opt/valheim \
  -v /opt/valheim/saves:/config \
  lloesche/valheim-server:latest
STARTSH
chmod +x /opt/valheim/start.sh

cat > /opt/valheim/stop.sh << 'STOPSH'
#!/bin/bash
docker stop -t 120 valheim 2>/dev/null
docker rm valheim 2>/dev/null
STOPSH
chmod +x /opt/valheim/stop.sh

cat > /opt/valheim/scripts/restore.sh << 'RESTORE'
#!/bin/bash
set -euo pipefail

if [ -z "${1:-}" ]; then
    echo "Usage: $0 <backup.zip | s3://bucket/path/to/backup.zip>"
    exit 1
fi

BACKUP_PATH="$1"
SAVES_DIR="/opt/valheim/saves"

cd /opt/valheim
/opt/valheim/stop.sh || true

if [[ "$BACKUP_PATH" == s3://* ]]; then
    aws s3 cp "$BACKUP_PATH" /tmp/restore-backup.zip
    BACKUP_PATH="/tmp/restore-backup.zip"
fi

rm -rf "$SAVES_DIR"/worlds_local/*
unzip -o "$BACKUP_PATH" -d /tmp/restore-extract
if [ -d /tmp/restore-extract/config/worlds_local ]; then
    cp -a /tmp/restore-extract/config/worlds_local/* "$SAVES_DIR"/worlds_local/
fi
rm -rf /tmp/restore-extract

/opt/valheim/start.sh
echo "Restore completed from: $1"
RESTORE

chmod +x /opt/valheim/scripts/*.sh

if [ -n "${S3_BACKUP_BUCKET:-}" ]; then
    LATEST_BACKUP=$(aws s3 ls "s3://$S3_BACKUP_BUCKET/backups/" 2>/dev/null | sort | tail -n 1 | awk '{print $4}' || echo "")
    if [ -n "$LATEST_BACKUP" ]; then
        echo "Restoring from latest backup: $LATEST_BACKUP"
        aws s3 cp "s3://$S3_BACKUP_BUCKET/backups/$LATEST_BACKUP" /tmp/latest-backup.zip
        dnf install -y unzip
        unzip -o /tmp/latest-backup.zip -d /tmp/backup-extract
        if [ -d /tmp/backup-extract/config/worlds_local ]; then
            cp -a /tmp/backup-extract/config/worlds_local/* /opt/valheim/saves/worlds_local/ 2>/dev/null || true
        fi
        rm -rf /tmp/latest-backup.zip /tmp/backup-extract
    fi
fi

cd /opt/valheim
/opt/valheim/start.sh

cat > /etc/systemd/system/valheim.service << 'SERVICE'
[Unit]
Description=Valheim Dedicated Server
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/valheim/start.sh
ExecStop=/opt/valheim/stop.sh

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable valheim.service

echo "Valheim server setup completed at $(date)"
