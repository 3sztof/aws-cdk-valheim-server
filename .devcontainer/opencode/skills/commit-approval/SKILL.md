---
name: commit-approval
description: Always ask for user approval before committing changes to any repository
---

## Commit Approval Rule

**NEVER commit changes without explicit user approval.**

**NEVER push to any remote. The user always handles `git push` themselves.**

### Workflow

1. When work is complete and ready to commit:
   - Summarize what changes were made
   - Ask: "Ready to commit? Would you like me to proceed?"

2. Wait for explicit approval before running `git commit`

3. If user says "yes", "go ahead", "commit it", etc. → proceed with commit

4. If user wants changes → make adjustments first, then ask again

### Examples

**Good:**
```
Done. Changes made:
- Updated featured.png with new thumbnail
- Fixed typo in index.md

Ready to commit these changes?
```

**Bad:**
```
Done. Committing changes now...
[commits without asking]
```

```
Rebase complete. Pushing now...
[pushes without asking]
```

### Why This Matters

- User maintains control over git history
- Prevents unwanted commits and pushes
- Allows review before permanent changes
- Respects user's workflow preferences

### Applies To

- All `git commit` commands
- All `git commit --amend` commands
- Any operation that modifies git history
- `git push`, `git push --force`, `git push --force-with-lease` - NEVER push. The user always handles pushing themselves.
