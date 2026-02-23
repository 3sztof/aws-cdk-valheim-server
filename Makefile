.DEFAULT_GOAL := help
.PHONY: help init install build synth deploy destroy diff start stop status bootstrap clean \
        world-download world-upload world-list backup logs share

STACK_NAME := ValheimServerStack
WORLDS_REMOTE := /opt/valheim/saves/worlds_local
WORLDS_LOCAL := ./worlds

help:
	@echo "Valheim Server - AWS CDK"
	@echo ""
	@echo "Setup:"
	@echo "  make init           Create config.yaml from template (first time)"
	@echo "  make install        Install npm dependencies"
	@echo "  make bootstrap      Bootstrap CDK (first time only)"
	@echo ""
	@echo "Stack:"
	@echo "  make deploy         Build and deploy to AWS"
	@echo "  make destroy        Tear down the stack"
	@echo "  make diff           Preview changes before deploying"
	@echo "  make synth          Generate CloudFormation template"
	@echo ""
	@echo "Server:"
	@echo "  make start          Start the game server"
	@echo "  make stop           Stop the game server"
	@echo "  make status         Check server state and public IP"
	@echo "  make logs           Tail Valheim container logs"
	@echo ""
	@echo "World Management:"
	@echo "  make world-list     List world files on server"
	@echo "  make world-download Download world files to ./worlds/"
	@echo "  make world-upload   Upload world files from ./worlds/ (stops server!)"
	@echo "  make backup         Trigger a manual backup to S3"
	@echo ""
	@echo "Other:"
	@echo "  make build          Compile TypeScript"
	@echo "  make clean          Remove build artifacts"
	@echo "  make share          Show commands friends can use to start/stop/check the server"

# --- helpers ---

define get_instance_id
$$(aws cloudformation describe-stacks --stack-name $(STACK_NAME) \
	--query 'Stacks[0].Outputs[?contains(OutputKey,`InstanceId`)].OutputValue' \
	--output text 2>/dev/null)
endef

define get_api_url
$$(aws cloudformation describe-stacks --stack-name $(STACK_NAME) \
	--query 'Stacks[0].Outputs[?contains(OutputKey,`ApiUrl`)].OutputValue' \
	--output text 2>/dev/null)
endef

# --- setup ---

init:
	@if [ -f config.yaml ]; then \
		echo "config.yaml already exists. Remove it first to re-initialize."; \
		exit 1; \
	fi
	@cp config.yaml.example config.yaml
	@echo "Created config.yaml from template."
	@echo "Edit it with your server settings, then run: make deploy"

install:
	npm install
	@if command -v pre-commit >/dev/null 2>&1; then \
		pre-commit install || echo "Note: pre-commit install skipped (core.hooksPath may be set)"; \
	else \
		echo "Note: Install pre-commit for secret leak detection: pip install pre-commit && make install"; \
	fi

bootstrap:
	npx cdk bootstrap

# --- stack ---

build:
	npm run build

synth: build
	npx cdk synth

deploy: build
	npx cdk deploy --require-approval broadening

destroy:
	npx cdk destroy

diff: build
	npx cdk diff

# --- server control ---

start:
	@curl -s "$(call get_api_url)server/start" | jq .

stop:
	@curl -s "$(call get_api_url)server/stop" | jq .

status:
	@curl -s "$(call get_api_url)server/status" | jq .

logs:
	@INSTANCE_ID=$(call get_instance_id) && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters 'commands=["docker logs --tail 50 valheim 2>&1"]' \
		--output json --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 5 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "StandardOutputContent" --output text'

# --- world management ---

world-list:
	@INSTANCE_ID=$(call get_instance_id) && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters 'commands=["ls -lah $(WORLDS_REMOTE)/ 2>/dev/null || echo No worlds found"]' \
		--output json --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 5 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "StandardOutputContent" --output text'

world-download:
	@echo "Downloading world files from server..."
	@mkdir -p $(WORLDS_LOCAL)
	@INSTANCE_ID=$(call get_instance_id) && \
	IP=$$(aws ec2 describe-instances --instance-ids "$$INSTANCE_ID" \
		--query 'Reservations[0].Instances[0].PublicIpAddress' --output text) && \
	echo "Fetching file list..." && \
	CMD_ID=$$(aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters 'commands=["cd $(WORLDS_REMOTE) && tar czf /tmp/valheim-worlds.tar.gz . 2>/dev/null && echo PACKED || echo EMPTY"]' \
		--output json --query 'Command.CommandId' --output text) && \
	sleep 5 && \
	RESULT=$$(aws ssm get-command-invocation --command-id "$$CMD_ID" --instance-id "$$INSTANCE_ID" \
		--query "StandardOutputContent" --output text) && \
	if echo "$$RESULT" | grep -q "PACKED"; then \
		echo "Copying via SSM..." && \
		aws ssm start-session --target "$$INSTANCE_ID" \
			--document-name "AWS-StartPortForwardingSession" \
			--parameters '{"portNumber":["22"],"localPortNumber":["2222"]}' & \
		sleep 3 && \
		scp -P 2222 -o StrictHostKeyChecking=no localhost:/tmp/valheim-worlds.tar.gz $(WORLDS_LOCAL)/ && \
		kill %1 2>/dev/null; \
		cd $(WORLDS_LOCAL) && tar xzf valheim-worlds.tar.gz && rm valheim-worlds.tar.gz; \
		echo "World files downloaded to $(WORLDS_LOCAL)/"; \
	else \
		echo "No world files found on server."; \
	fi

world-upload:
	@if [ ! -d "$(WORLDS_LOCAL)" ] || [ -z "$$(ls -A $(WORLDS_LOCAL)/*.fwl 2>/dev/null)" ]; then \
		echo "Error: No world files found in $(WORLDS_LOCAL)/"; \
		echo ""; \
		echo "Place your world files (.fwl and .db) in $(WORLDS_LOCAL)/ first."; \
		echo ""; \
		echo "Local world files are typically found at:"; \
		echo "  Windows: %USERPROFILE%\\AppData\\LocalLow\\IronGate\\Valheim\\worlds_local\\"; \
		echo "  macOS:   ~/Library/Application Support/unity.IronGate.Valheim/worlds_local/"; \
		echo "  Linux:   ~/.config/unity3d/IronGate/Valheim/worlds_local/"; \
		echo ""; \
		echo "You need both <world>.fwl and <world>.db files."; \
		echo "The world name must match server.world in config.yaml."; \
		exit 1; \
	fi
	@echo ""
	@echo "WARNING: This will stop the Valheim server, replace world files,"
	@echo "         and restart it. A backup will be taken first."
	@echo ""
	@echo "Files to upload:"
	@ls -lah $(WORLDS_LOCAL)/*.fwl $(WORLDS_LOCAL)/*.db 2>/dev/null || true
	@echo ""
	@read -p "Continue? [y/N] " confirm && [ "$$confirm" = "y" ] || (echo "Aborted."; exit 1)
	@INSTANCE_ID=$(call get_instance_id) && \
	echo "1/4 Taking backup..." && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters 'commands=["docker exec $$(docker ps -q --filter name=valheim) /usr/local/bin/valheim-backup"]' \
		--output text --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 10 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "StandardOutputContent" --output text' && \
	echo "2/4 Stopping Valheim container..." && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters 'commands=["/opt/valheim/stop.sh"]' \
		--output text --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 15 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "Status" --output text' && \
	echo "3/4 Uploading world files..." && \
	cd $(WORLDS_LOCAL) && tar czf /tmp/valheim-worlds-upload.tar.gz *.fwl *.db 2>/dev/null && cd - > /dev/null && \
	BUCKET=$$(aws cloudformation describe-stacks --stack-name $(STACK_NAME) \
		--query 'Stacks[0].Outputs[?contains(OutputKey,`BucketName`)].OutputValue' \
		--output text) && \
	aws s3 cp /tmp/valheim-worlds-upload.tar.gz "s3://$$BUCKET/upload/worlds.tar.gz" && \
	rm /tmp/valheim-worlds-upload.tar.gz && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters "commands=[\"aws s3 cp s3://$$BUCKET/upload/worlds.tar.gz /tmp/worlds.tar.gz && tar xzf /tmp/worlds.tar.gz -C $(WORLDS_REMOTE)/ && rm /tmp/worlds.tar.gz && echo UPLOADED\"]" \
		--output text --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 10 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "StandardOutputContent" --output text' && \
	echo "4/4 Starting Valheim container..." && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters 'commands=["/opt/valheim/start.sh"]' \
		--output text --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 10 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "StandardOutputContent" --output text' && \
	echo "" && \
	echo "Done! World files uploaded and server restarted."

backup:
	@INSTANCE_ID=$(call get_instance_id) && \
	echo "Triggering backup..." && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters 'commands=["docker exec $$(docker ps -q --filter name=valheim) /usr/local/bin/valheim-backup"]' \
		--output json --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 10 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "StandardOutputContent" --output text'

# --- other ---

share:
	@API_URL=$(call get_api_url) && \
	if [ -z "$$API_URL" ] || [ "$$API_URL" = "None" ]; then \
		echo "Error: Stack not deployed. Run 'make deploy' first."; \
		exit 1; \
	fi && \
	echo "=== Valheim Server Commands ===" && \
	echo "" && \
	echo "Share these with your friends so they can control the server." && \
	echo "" && \
	echo "--- Start Server ---" && \
	echo "" && \
	echo "  curl $${API_URL}server/start" && \
	echo "" && \
	echo "  wget -qO- $${API_URL}server/start" && \
	echo "" && \
	echo "  Invoke-WebRequest -Uri $${API_URL}server/start" && \
	echo "" && \
	echo "--- Stop Server ---" && \
	echo "" && \
	echo "  curl $${API_URL}server/stop" && \
	echo "" && \
	echo "  wget -qO- $${API_URL}server/stop" && \
	echo "" && \
	echo "  Invoke-WebRequest -Uri $${API_URL}server/stop" && \
	echo "" && \
	echo "--- Check Status ---" && \
	echo "" && \
	echo "  curl $${API_URL}server/status" && \
	echo "" && \
	echo "  wget -qO- $${API_URL}server/status" && \
	echo "" && \
	echo "  Invoke-WebRequest -Uri $${API_URL}server/status"

clean:
	rm -rf cdk.out cdk-nag-out lib/**/*.js lib/**/*.d.ts bin/*.js bin/*.d.ts
