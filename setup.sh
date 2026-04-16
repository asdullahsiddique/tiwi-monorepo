#!/usr/bin/env bash
# setup.sh — run ONCE locally before your first deploy.
#
# This creates the Pulumi stack and stores all secrets encrypted in Pulumi.prod.yaml.
# After running this, commit the file and push — GitHub Actions handles everything else.
#
# Prerequisites:
#   pulumi CLI   (brew install pulumi)
#   source aws-tiwi  ← your SSO credentials script
#
set -euo pipefail

cd "$(dirname "$0")/infra"

echo "==> Selecting or creating Pulumi stack 'prod'..."
pulumi stack select tiwi/prod 2>/dev/null || pulumi stack init tiwi/prod

echo ""
echo "==> Setting region..."
pulumi config set aws:region eu-central-1   # stored in Pulumi.prod.yaml with 'value'

echo ""
echo "==> Enter your config values (secrets are encrypted and safe to commit):"
echo ""

read -rp  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (pk_live_...): " CLERK_PK
pulumi config set tiwi:clerkPublishableKey "$CLERK_PK"

read -rsp "CLERK_SECRET_KEY (sk_live_...): " CLERK_SK; echo
pulumi config set --secret tiwi:clerkSecretKey "$CLERK_SK"

read -rsp "OPENAI_API_KEY (sk-...): " OAI_KEY; echo
pulumi config set --secret tiwi:openAiApiKey "$OAI_KEY"

read -rsp "MONGODB_URI (mongodb+srv://...): " MONGO_URI; echo
pulumi config set --secret tiwi:mongoUri "$MONGO_URI"

read -rsp "PINECONE_API_KEY: " PC_KEY; echo
pulumi config set --secret tiwi:pineconeApiKey "$PC_KEY"

read -rp "PINECONE_INDEX (plain index name): " PC_INDEX
pulumi config set tiwi:pineconeIndex "$PC_INDEX"

read -rsp "ASSEMBLYAI_API_KEY (optional — press Enter to skip): " ASSEMBLY_KEY; echo
[ -n "$ASSEMBLY_KEY" ] && pulumi config set --secret tiwi:assemblyAiApiKey "$ASSEMBLY_KEY"

echo ""
echo "==> Staging Pulumi.prod.yaml for commit..."
git -C .. add Pulumi.prod.yaml 2>/dev/null || true

cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Setup complete!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Next steps:

 1. Add these two secrets to GitHub:
    GitHub → Settings → Secrets and variables → Actions

      PULUMI_ACCESS_TOKEN  — from https://app.pulumi.com/account/tokens
      AWS_ROLE_ARN         — IAM role ARN that GitHub Actions will assume

    The IAM role needs these permissions:
      - AmazonEC2FullAccess
      - AmazonECS_FullAccess
      - AmazonECRFullAccess (or AmazonEC2ContainerRegistryFullAccess)
      - AmazonS3FullAccess
      - SecretsManagerReadWrite
      - IAMFullAccess
      - CloudWatchLogsFullAccess
      - ElasticLoadBalancingFullAccess
    Trust policy must allow: sts:AssumeRoleWithWebIdentity from token.actions.githubusercontent.com

 2. Commit and push:
      git add infra/Pulumi.prod.yaml
      git commit -m "chore: init Pulumi stack"
      git push

    GitHub Actions will run automatically and deploy everything.

 3. After the first deploy, add a CNAME in Cloudflare:
      Name   : your subdomain (e.g. app)
      Target : <the albDns value from pulumi stack output albDns>
      Proxy  : ON

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EOF
