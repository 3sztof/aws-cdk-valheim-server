---
name: aws-safe-ops
description: Require explicit user approval before executing destructive or irreversible AWS operations. Covers S3 deletion, EC2 termination, RDS drops, IAM mutations, CloudFormation destroys, and more.
---

## AWS Safe Operations Rule

**NEVER execute destructive or irreversible AWS operations without explicit user approval.**

### What Counts as Destructive

These operations MUST be approved before execution:

**S3**
- `aws s3 rb` (remove bucket) - with or without `--force`
- `aws s3 rm` with `--recursive`
- `aws s3api delete-objects`
- `aws s3api delete-bucket`
- Any deletion of object versions or delete markers

**EC2 / Compute**
- `aws ec2 terminate-instances` (permanent - not the same as stop)
- `aws ec2 delete-*` (security groups, key pairs, snapshots, AMIs, VPCs, subnets, etc.)
- `aws autoscaling delete-auto-scaling-group`

**RDS / Databases**
- `aws rds delete-db-instance`
- `aws rds delete-db-cluster`
- `aws rds delete-db-snapshot`
- `aws dynamodb delete-table`

**IAM**
- `aws iam delete-user`
- `aws iam delete-role`
- `aws iam delete-policy`
- `aws iam detach-*` / `aws iam remove-*` (removing permissions)
- `aws iam delete-access-key`

**CloudFormation**
- `cdk destroy`
- `aws cloudformation delete-stack`

**Other**
- `aws lambda delete-function`
- `aws logs delete-log-group`
- `aws route53 delete-hosted-zone`
- `aws acm delete-certificate`
- Any `--force` flag on a deletion command

### Required Approval Workflow

1. **Before the operation** - show exactly what will be deleted:
   - Resource name/ARN/ID
   - Size or content summary if knowable (e.g. bucket object count)
   - Whether it is recoverable (most are not)

2. **Ask explicitly:**
   ```
   This will permanently delete [resource]. This cannot be undone.
   Proceed? [yes/no]
   ```

3. **Wait for explicit confirmation** - "yes", "go ahead", "do it", "confirmed", etc.

4. **If multiple resources** - ask per-resource or present a clear list and ask once for the batch.

### Pre-flight: Always Describe Before Deleting

Before any deletion, run the corresponding read/describe command first:

```bash
# Before deleting a bucket - check its contents
aws s3 ls s3://bucket-name --recursive --human-readable --summarize

# Before terminating an instance - confirm it's the right one
aws ec2 describe-instances --instance-ids i-xxx --query 'Reservations[0].Instances[0].[InstanceId,State.Name,Tags]'

# Before deleting a stack - check what's in it
aws cloudformation describe-stack-resources --stack-name MyStack
```

### Safe Operations (No Approval Needed)

Read-only operations never need approval:
- `describe-*`, `list-*`, `get-*`
- `aws s3 ls`
- `aws cloudformation describe-stacks`
- `aws ec2 stop-instances` (recoverable - instance can be restarted)
- `aws ec2 start-instances`
- Creating new resources (not replacing existing ones)

### Example: Good Workflow

```
I found 3 stale S3 buckets:
- my-bucket-old (empty)
- my-bucket-2023 (12 objects, 4.2 MB - world backups from Jan 2023)
- my-log-bucket (89 log files, 1.1 MB)

Delete all three? (irreversible)
```

Wait for: "yes" / "delete them" / "go ahead"

Then execute deletions.

### Example: Bad Workflow

```bash
# NEVER do this without asking first
aws s3 rb s3://my-bucket --force
aws ec2 terminate-instances --instance-ids i-abc123
```

### Why This Matters

- AWS deletions are permanent - no recycle bin, no undo
- Versioned S3 buckets require extra steps and can still have hidden content
- Wrong instance ID terminates production
- IAM key deletion locks out users immediately
- Stack deletion can cascade and wipe dozens of resources at once
