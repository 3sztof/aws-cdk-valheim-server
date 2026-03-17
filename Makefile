.DEFAULT_GOAL := help
.PHONY: help init install build synth deploy destroy diff start stop status bootstrap clean \
        world-download world-upload world-list world-reset world-restore backup logs logs-tail share \
        check-aws-auth check-instance-running layer-deps-update pre-deploy-backup

# Derive the CloudFormation stack name from workload_name in config.yaml,
# mirroring the PascalCase logic in bin/valheim-server.ts.
# e.g. "valheim" -> "ValheimStack", "game-server" -> "GameServerStack"
WORKLOAD_NAME := $(shell grep '^workload_name:' config.yaml 2>/dev/null | head -1 | awk '{print $$2}' | tr -d '"' | tr -d "'" | xargs)
ifeq ($(WORKLOAD_NAME),)
  WORKLOAD_NAME := valheim
endif
STACK_NAME := $(shell echo "$(WORKLOAD_NAME)" | awk -F'-' '{for(i=1;i<=NF;i++) $$i=toupper(substr($$i,1,1)) substr($$i,2); print}' OFS='')Stack
WORLDS_REMOTE := /opt/valheim/saves/worlds_local
WORLDS_LOCAL := ./.worlds

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
	@echo "  make logs           Show last 50 lines of Valheim container logs"
	@echo "  make logs-tail      Stream Valheim container logs live (Ctrl+C to exit)"
	@echo ""
	@echo "World Management:"
	@echo "  make world-list     List world files on server"
	@echo "  make world-download Download world files to ./.worlds/"
	@echo "  make world-upload   Upload world files from ./.worlds/ (stops server!)"
	@echo "  make world-reset    Delete all world files from server (fresh start)"
	@echo "  make world-restore  Restore world from latest S3 backup (stops server!)"
	@echo "  make backup         Trigger a manual backup to S3"
	@echo "Other:"
	@echo "  make build               Compile TypeScript"
	@echo "  make layer-deps-update   Regenerate uv.lock files for lambda layers"
	@echo "  make clean               Remove build artifacts"
	@echo "  make share               Show commands friends can use to start/stop/check the server"

# --- helpers ---

check-aws-auth:
	@aws sts get-caller-identity > /dev/null 2>&1 || ( \
		echo ""; \
		echo "Error: AWS credentials not found or expired."; \
		echo ""; \
		echo "Authenticate via the AWS CLI before running this command:"; \
		echo "  aws sso login                      # if using AWS SSO"; \
		echo "  aws configure                      # if using access keys"; \
		echo "  export AWS_PROFILE=<profile>       # to switch profiles"; \
		echo ""; \
		exit 1 \
	)

check-instance-running: check-aws-auth
	@STATE=$(call get_instance_state) && \
	if [ "$$STATE" != "running" ]; then \
		echo ""; \
		echo "Error: EC2 instance is not running (current state: $${STATE:-unknown})."; \
		echo ""; \
		echo "Start the server first:  make start"; \
		echo "Check current status:    make status"; \
		echo ""; \
		exit 1; \
	fi
define get_instance_id
$$(aws cloudformation describe-stacks --stack-name $(STACK_NAME) \
	--query 'Stacks[0].Outputs[?contains(OutputKey,`InstanceId`)].OutputValue' \
	--output text 2>/dev/null || echo "")
endef

define get_api_url
$$(aws cloudformation describe-stacks --stack-name $(STACK_NAME) \
	--query 'Stacks[0].Outputs[?contains(OutputKey,`ApiUrl`)].OutputValue' \
	--output text 2>/dev/null)
endef

define get_custom_domain_url
$$(aws cloudformation describe-stacks --stack-name $(STACK_NAME) \
	--query 'Stacks[0].Outputs[?OutputKey==`ControlCustomDomainUrl`].OutputValue' \
	--output text 2>/dev/null)
endef

define get_bucket_name
$(shell aws cloudformation describe-stacks --stack-name $(STACK_NAME) \
	--query 'Stacks[0].Outputs[?contains(OutputKey,`BucketName`)].OutputValue' \
	--output text 2>/dev/null)
endef

define get_instance_state
$(shell \
	_id=$(call get_instance_id); \
	if [ -z "$$_id" ] || [ "$$_id" = "None" ]; then echo "not-found"; else \
	aws ec2 describe-instances \
		--instance-ids $$_id \
		--query 'Reservations[0].Instances[0].State.Name' \
		--output text 2>/dev/null; fi)
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

bootstrap: check-aws-auth
	npx cdk bootstrap

# --- stack ---

build:
	npm run build

synth: check-aws-auth build
	npx cdk synth

pre-deploy-backup: check-aws-auth
	@INSTANCE_ID=$(call get_instance_id); \
	if [ -z "$$INSTANCE_ID" ] || [ "$$INSTANCE_ID" = "None" ]; then \
		echo "No existing stack found - skipping pre-deploy backup (fresh deploy)."; \
	else \
		STATE=$$(aws ec2 describe-instances \
			--instance-ids "$$INSTANCE_ID" \
			--query 'Reservations[0].Instances[0].State.Name' \
			--output text 2>/dev/null || echo "unknown") && \
		if [ "$$STATE" = "running" ]; then \
			echo ""; \
			echo "Pre-deploy backup: triggering backup of current world before deployment..."; \
			CMD_ID=$$(aws ssm send-command --instance-ids "$$INSTANCE_ID" \
				--document-name "AWS-RunShellScript" \
				--parameters "{\"commands\":[\"docker exec $(WORKLOAD_NAME) /usr/local/bin/valheim-backup\"]}" \
				--output text --query 'Command.CommandId' 2>/dev/null) && \
			echo "Backup command sent (id: $$CMD_ID). Waiting up to 60s..." && \
			for i in $$(seq 1 12); do \
				sleep 5; \
				STATUS=$$(aws ssm get-command-invocation --command-id "$$CMD_ID" \
					--instance-id "$$INSTANCE_ID" --query 'Status' --output text 2>/dev/null || echo "Pending"); \
				if [ "$$STATUS" = "Success" ]; then \
					echo "Pre-deploy backup completed successfully."; \
					break; \
				fi; \
				if [ "$$STATUS" = "Failed" ] || [ "$$STATUS" = "Cancelled" ] || [ "$$STATUS" = "TimedOut" ]; then \
					echo "WARNING: Pre-deploy backup failed (status: $$STATUS). World may not be saved."; \
					echo "Run 'make backup' manually and verify before proceeding."; \
					read -p "Continue with deploy anyway? [y/N] " confirm && [ "$$confirm" = "y" ] || (echo "Deploy aborted."; exit 1); \
					break; \
				fi; \
				echo "  $$i/12 - status: $$STATUS..."; \
			done; \
		else \
			echo "Server is not running (state: $$STATE) - skipping pre-deploy backup."; \
		fi; \
	fi

deploy: check-aws-auth build pre-deploy-backup
	npx cdk deploy --require-approval broadening

destroy: check-aws-auth
	npx cdk destroy

diff: check-aws-auth build
	npx cdk diff

# --- server control ---

start: check-aws-auth
	@curl -s "$(call get_api_url)server/start" | jq .

stop: check-aws-auth
	@curl -s "$(call get_api_url)server/stop" | jq .

status: check-aws-auth
	@curl -s "$(call get_api_url)server/status" | jq .

logs: check-instance-running
	@INSTANCE_ID=$(call get_instance_id) && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters "{\"commands\":[\"docker logs --tail 50 $(WORKLOAD_NAME) 2>&1\"]}" \
		--output json --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 5 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "StandardOutputContent" --output text'

logs-tail: check-instance-running
	@echo "Streaming logs (Ctrl+C to exit)..."
	@INSTANCE_ID=$(call get_instance_id) && \
	aws ssm start-session --target "$$INSTANCE_ID" \
		--document-name "AWS-StartInteractiveCommand" \
		--parameters "{\"command\":[\"docker logs -f $(WORKLOAD_NAME) 2>&1\"]}"

# --- world management ---

world-list: check-instance-running
	@INSTANCE_ID=$(call get_instance_id) && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters 'commands=["ls -lah $(WORLDS_REMOTE)/ 2>/dev/null || echo No worlds found"]' \
		--output json --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 5 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "StandardOutputContent" --output text'

world-download: check-instance-running
	@echo "Downloading world files from server..."
	@mkdir -p $(WORLDS_LOCAL)
	@INSTANCE_ID=$(call get_instance_id) && \
	BUCKET=$(call get_bucket_name) && \
	echo "Packing world files on instance..." && \
	CMD=$$(printf '%s' "ls $(WORLDS_REMOTE)/*.fwl $(WORLDS_REMOTE)/*.db >/dev/null 2>&1 || { echo EMPTY; exit 0; }; cd $(WORLDS_REMOTE) && tar czf /tmp/valheim-worlds.tar.gz . && aws s3 cp /tmp/valheim-worlds.tar.gz s3://$$BUCKET/download/worlds.tar.gz && rm /tmp/valheim-worlds.tar.gz && echo UPLOADED") && \
	CMD_ID=$$(aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters "{\"commands\":[\"$$CMD\"]}" \
		--output text --query 'Command.CommandId') && \
	echo "Waiting for SSM command to complete..." && \
	for i in $$(seq 1 24); do \
		STATUS=$$(aws ssm get-command-invocation --command-id "$$CMD_ID" --instance-id "$$INSTANCE_ID" \
			--query 'Status' --output text 2>/dev/null); \
		if [ "$$STATUS" = "Success" ]; then break; fi; \
		if [ "$$STATUS" = "Failed" ] || [ "$$STATUS" = "Cancelled" ] || [ "$$STATUS" = "TimedOut" ]; then \
			echo "SSM command failed (status: $$STATUS). Check instance logs for details."; exit 1; fi; \
		sleep 5; \
	done && \
	RESULT=$$(aws ssm get-command-invocation --command-id "$$CMD_ID" --instance-id "$$INSTANCE_ID" \
		--query 'StandardOutputContent' --output text) && \
	if echo "$$RESULT" | grep -q "UPLOADED"; then \
		echo "Copying from S3..." && \
		aws s3 cp "s3://$$BUCKET/download/worlds.tar.gz" $(WORLDS_LOCAL)/worlds.tar.gz && \
		aws s3 rm "s3://$$BUCKET/download/worlds.tar.gz" && \
		cd $(WORLDS_LOCAL) && tar xzf worlds.tar.gz && rm worlds.tar.gz; \
		echo "World files downloaded to $(WORLDS_LOCAL)/"; \
	else \
		echo "No world files found on server."; \
	fi

world-upload: check-instance-running
	@CONFIGURED_WORLD=$$(grep 'world:' config.yaml | head -1 | awk '{print $$2}' | tr -d '"') && \
	FWL_FILES=$$(ls $(WORLDS_LOCAL)/*.fwl 2>/dev/null) && \
	if [ -z "$$FWL_FILES" ]; then \
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
	fi && \
	LOCAL_NAMES=$$(for f in $(WORLDS_LOCAL)/*.fwl; do basename "$$f" .fwl; done | grep -v '_backup' | sort -u) && \
	echo "" && \
	if ! echo "$$LOCAL_NAMES" | grep -qx "$$CONFIGURED_WORLD"; then \
		echo "WARNING: Name mismatch detected."; \
		echo ""; \
		echo "  Local world files : $$LOCAL_NAMES"; \
		echo "  config.yaml world : $$CONFIGURED_WORLD"; \
		echo ""; \
		echo "The server loads the world named in config.yaml (\"$$CONFIGURED_WORLD\")."; \
		echo "If the uploaded files have a different name, the server will ignore them"; \
		echo "and generate a fresh world instead."; \
		echo ""; \
		echo "Fix options:"; \
		echo "  1. Rename the files in $(WORLDS_LOCAL)/ to match $$CONFIGURED_WORLD"; \
		echo "  2. Update server.world in config.yaml to match the file name, then redeploy"; \
		echo ""; \
		read -p "Upload anyway? [y/N] " confirm && [ "$$confirm" = "y" ] || (echo "Aborted."; exit 1); \
	fi && \
	echo "WARNING: This will stop the Valheim server, replace world files," && \
	echo "         and restart it. A backup will be taken first." && \
	echo "" && \
	echo "Files to upload:" && \
	ls -lah $(WORLDS_LOCAL)/*.fwl $(WORLDS_LOCAL)/*.db 2>/dev/null || true && \
	echo "" && \
	read -p "Continue? [y/N] " confirm && [ "$$confirm" = "y" ] || (echo "Aborted."; exit 1)
	@INSTANCE_ID=$(call get_instance_id) && \
	echo "1/4 Taking backup..." && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters "{\"commands\":[\"docker exec $(WORKLOAD_NAME) /usr/local/bin/valheim-backup\"]}" \
		--output text --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 10 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "StandardOutputContent" --output text' && \
	echo "2/4 Stopping ${WORKLOAD_NAME} container..." && \
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

world-restore: check-instance-running
	@echo ""
	@echo "WARNING: This will restore world files from the latest S3 backup."
	@echo "         The server will be stopped and restarted. Current world files"
	@echo "         will be overwritten with the backup contents."
	@echo ""
	@BUCKET=$$(aws cloudformation describe-stacks --stack-name $(STACK_NAME) \
		--query 'Stacks[0].Outputs[?contains(OutputKey,`BucketName`)].OutputValue' \
		--output text) && \
	LATEST=$$(aws s3 ls "s3://$$BUCKET/backups/" | sort | tail -n 1 | awk '{print $$4}') && \
	if [ -z "$$LATEST" ]; then \
		echo "Error: No backups found in s3://$$BUCKET/backups/"; \
		echo ""; \
		echo "Run 'make backup' to create one first."; \
		exit 1; \
	fi && \
	echo "Backup to restore: s3://$$BUCKET/backups/$$LATEST" && \
	echo "" && \
	read -p "Continue? [y/N] " confirm && [ "$$confirm" = "y" ] || (echo "Aborted."; exit 1) && \
	INSTANCE_ID=$(call get_instance_id) && \
	echo "Invoking restore.sh on instance (stops server, restores from S3, restarts)..." && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters "commands=[\"/opt/valheim/scripts/restore.sh s3://$$BUCKET/backups/$$LATEST\"]" \
		--output text --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 30 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "StandardOutputContent" --output text' && \
	echo "" && \
	echo "Done. World restored from s3://$$BUCKET/backups/$$LATEST"

world-reset: check-instance-running
	@echo ""
	@echo "WARNING: This will permanently delete all world files on the server."
	@echo "         The server will be stopped and restarted without any world data."
	@echo "         Run 'make backup' first if you want to preserve the current world."
	@echo ""
	@read -p "Type 'yes' to confirm: " confirm && [ "$$confirm" = "yes" ] || (echo "Aborted."; exit 1)
	@INSTANCE_ID=$(call get_instance_id) && \
	echo "1/3 Stopping Valheim container..." && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters 'commands=["/opt/valheim/stop.sh"]' \
		--output text --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 10 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "Status" --output text' && \
	echo "2/3 Deleting all world files..." && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters 'commands=["rm -rf $(WORLDS_REMOTE)/* && echo DELETED"]' \
		--output text --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 5 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "StandardOutputContent" --output text' && \
	echo "3/3 Starting Valheim container..." && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters 'commands=["/opt/valheim/start.sh"]' \
		--output text --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 10 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "Status" --output text' && \
	echo "" && \
	echo "Done. World files deleted - server will generate a fresh world on next load."

backup: check-instance-running
	@INSTANCE_ID=$(call get_instance_id) && \
	echo "Triggering backup..." && \
	aws ssm send-command --instance-ids "$$INSTANCE_ID" \
		--document-name "AWS-RunShellScript" \
		--parameters "{\"commands\":[\"docker exec $(WORKLOAD_NAME) /usr/local/bin/valheim-backup\"]}" \
		--output json --query 'Command.CommandId' | \
	xargs -I{} sh -c 'sleep 10 && aws ssm get-command-invocation \
		--command-id {} --instance-id "'"$$INSTANCE_ID"'" \
		--query "StandardOutputContent" --output text'

# --- other ---

share: check-aws-auth
	@API_URL=$(call get_api_url) && \
	CUSTOM_URL=$(call get_custom_domain_url) && \
	if [ -z "$$API_URL" ] || [ "$$API_URL" = "None" ]; then \
		echo "Error: Stack not deployed. Run 'make deploy' first."; \
		exit 1; \
	fi && \
	if [ -n "$$CUSTOM_URL" ] && [ "$$CUSTOM_URL" != "None" ]; then \
		START_URL=$${CUSTOM_URL}start; \
		STOP_URL=$${CUSTOM_URL}stop; \
		STATUS_URL=$${CUSTOM_URL}status; \
	else \
		START_URL=$${API_URL}server/start; \
		STOP_URL=$${API_URL}server/stop; \
		STATUS_URL=$${API_URL}server/status; \
	fi && \
	echo "=== Valheim Server Links ===" && \
	echo "" && \
	echo "Just open these links in a browser - no curl or wget needed!" && \
	echo "The commands below are optional, for scripting only." && \
	echo "" && \
	echo "--- Start Server ---" && \
	echo "" && \
	echo "  Browser: $${START_URL}" && \
	echo "" && \
	echo "  curl $${START_URL}" && \
	echo "  wget -qO- $${START_URL}" && \
	echo "  Invoke-WebRequest -Uri $${START_URL}" && \
	echo "" && \
	echo "--- Stop Server ---" && \
	echo "" && \
	echo "  Browser: $${STOP_URL}" && \
	echo "" && \
	echo "  curl $${STOP_URL}" && \
	echo "  wget -qO- $${STOP_URL}" && \
	echo "  Invoke-WebRequest -Uri $${STOP_URL}" && \
	echo "" && \
	echo "--- Check Status ---" && \
	echo "" && \
	echo "  Browser: $${STATUS_URL}" && \
	echo "" && \
	echo "  curl $${STATUS_URL}" && \
	echo "  wget -qO- $${STATUS_URL}" && \
	echo "  Invoke-WebRequest -Uri $${STATUS_URL}"

layer-deps-update:
	@echo "Regenerating uv.lock files for all lambda layers..."
	@cd lambda/control && uv lock
	@cd lambda/auto-shutdown && uv lock
	@echo "Done. Commit the updated uv.lock files."

clean:
	rm -rf cdk.out cdk-nag-out lib/**/*.js lib/**/*.d.ts bin/*.js bin/*.d.ts
