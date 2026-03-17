import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

// ─── Config / Secrets ─────────────────────────────────────────────────────────
// Set these with:
//   pulumi config set --secret tiwi:openAiApiKey         sk-...
//   pulumi config set --secret tiwi:neo4jUri             neo4j+s://...
//   pulumi config set --secret tiwi:neo4jPassword        ...
//   pulumi config set --secret tiwi:redisUrl             rediss://...upstash.io:6379
//   pulumi config set --secret tiwi:assemblyAiApiKey     ...   (optional)
const cfg = new pulumi.Config("tiwi");

const openAiApiKey     = cfg.requireSecret("openAiApiKey");
const neo4jUri         = cfg.requireSecret("neo4jUri");
const neo4jPassword    = cfg.requireSecret("neo4jPassword");
const redisUrl         = cfg.requireSecret("redisUrl");
const assemblyAiApiKey = cfg.getSecret("assemblyAiApiKey") ?? pulumi.output("");

// ─── AWS context ──────────────────────────────────────────────────────────────
const region   = aws.getRegionOutput();
const identity = aws.getCallerIdentityOutput();

// ─── VPC ──────────────────────────────────────────────────────────────────────
const vpc = new awsx.ec2.Vpc("tiwi", {
  numberOfAvailabilityZones: 2,
  natGateways: { strategy: "Single" },
  tags: { Name: "tiwi" },
});

// ─── Security Groups ──────────────────────────────────────────────────────────
// Daemon only needs outbound (connects to Upstash Redis, Neo4j, OpenAI, etc.)
const daemonSg = new aws.ec2.SecurityGroup("daemon-sg", {
  vpcId: vpc.vpcId,
  description: "ECS daemon - outbound only",
  egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
  tags: { Name: "tiwi-daemon" },
});

// ─── S3 ───────────────────────────────────────────────────────────────────────
const filesBucket = new aws.s3.BucketV2("files", {
  bucket: pulumi.interpolate`tiwi-files-${identity.accountId}-${region.name}`,
  tags: { Name: "tiwi-files" },
});

new aws.s3.BucketPublicAccessBlock("files-pab", {
  bucket: filesBucket.id,
  blockPublicAcls: true, blockPublicPolicy: true,
  ignorePublicAcls: true, restrictPublicBuckets: true,
});

new aws.s3.BucketCorsConfigurationV2("files-cors", {
  bucket: filesBucket.id,
  corsRules: [{
    allowedMethods: ["GET", "PUT"],
    allowedOrigins: ["*"],
    allowedHeaders: ["*"],
    maxAgeSeconds: 3000,
  }],
});

new aws.s3.BucketLifecycleConfigurationV2("files-lifecycle", {
  bucket: filesBucket.id,
  rules: [{
    id: "abort-incomplete-multipart",
    status: "Enabled",
    abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
  }],
});

// Redis URL comes from Upstash (accessible from both Vercel and ECS).
// Set via: pulumi config set --secret tiwi:redisUrl rediss://...upstash.io:6379

// ─── ECR Repository ───────────────────────────────────────────────────────────
const daemonRepo = new aws.ecr.Repository("daemon-repo", {
  name: "tiwi/daemon",
  imageTagMutability: "MUTABLE",
  imageScanningConfiguration: { scanOnPush: false },
  tags: { Name: "tiwi/daemon" },
});

new aws.ecr.LifecyclePolicy("daemon-repo-lifecycle", {
  repository: daemonRepo.name,
  policy: JSON.stringify({
    rules: [{
      rulePriority: 1, description: "Keep last 10 images",
      selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 10 },
      action: { type: "expire" },
    }],
  }),
});

// Build + push daemon Docker image during `pulumi up`.
const daemonImage = new awsx.ecr.Image("daemon-image", {
  repositoryUrl: daemonRepo.repositoryUrl,
  context: "../",
  dockerfile: "../apps/daemon/Dockerfile",
  platform: "linux/amd64",
});

// ─── Secrets Manager ─────────────────────────────────────────────────────────
function smSecret(
  name: string, secretName: string, value: pulumi.Output<string>,
): aws.secretsmanager.Secret {
  const secret = new aws.secretsmanager.Secret(name, { name: secretName });
  new aws.secretsmanager.SecretVersion(`${name}-ver`, {
    secretId: secret.id,
    secretString: value,
  });
  return secret;
}

const neo4jSecret = smSecret(
  "neo4j-secret", "tiwi/neo4j-v2",
  pulumi.jsonStringify({ NEO4J_URI: neo4jUri, NEO4J_USERNAME: "neo4j", NEO4J_PASSWORD: neo4jPassword }),
);

const openAiSecret = smSecret(
  "openai-secret", "tiwi/openai-v2",
  pulumi.jsonStringify({ OPENAI_API_KEY: openAiApiKey }),
);

const assemblyAiSecret = smSecret(
  "assemblyai-secret", "tiwi/assemblyai-v2",
  pulumi.jsonStringify({ ASSEMBLYAI_API_KEY: assemblyAiApiKey }),
);

// ─── IAM ──────────────────────────────────────────────────────────────────────
const ecsAssume = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole" }],
});

const executionRole = new aws.iam.Role("execution-role", {
  namePrefix: "tiwi-execution-",
  assumeRolePolicy: ecsAssume,
  managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"],
});

new aws.iam.RolePolicy("execution-sm", {
  role: executionRole.name,
  policy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow", Action: ["secretsmanager:GetSecretValue"],
      Resource: [neo4jSecret.arn, openAiSecret.arn, assemblyAiSecret.arn],
    }],
  }),
});

const taskRole = new aws.iam.Role("task-role", {
  namePrefix: "tiwi-task-",
  assumeRolePolicy: ecsAssume,
});

new aws.iam.RolePolicy("task-s3", {
  role: taskRole.name,
  policy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      Resource: [filesBucket.arn, pulumi.interpolate`${filesBucket.arn}/*`],
    }],
  }),
});

// ─── IAM User for Vercel (presigned URL signing) ──────────────────────────────
// Vercel cannot use IAM roles, so we create a least-privilege IAM user that can
// only sign presigned URLs (PutObject for uploads, GetObject for downloads).
const vercelUser = new aws.iam.User("vercel-s3-user", {
  name: "tiwi-vercel-s3",
  tags: { Name: "tiwi-vercel-s3" },
});

new aws.iam.UserPolicy("vercel-s3-policy", {
  user: vercelUser.name,
  policy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      Resource: pulumi.interpolate`${filesBucket.arn}/*`,
    }],
  }),
});

const vercelAccessKey = new aws.iam.AccessKey("vercel-s3-key", {
  user: vercelUser.name,
});

// ─── ECS Cluster ──────────────────────────────────────────────────────────────
const cluster = new aws.ecs.Cluster("cluster", {
  name: "tiwi",
  settings: [{ name: "containerInsights", value: "enabled" }],
});

// ─── CloudWatch Logs ──────────────────────────────────────────────────────────
const daemonLogGroup = new aws.cloudwatch.LogGroup("daemon-logs", {
  name: "/ecs/tiwi/daemon",
  retentionInDays: 7,
});

// ─── Helper: ECS secret reference from Secrets Manager JSON key ───────────────
const secretRef = (arn: pulumi.Output<string>, key: string) => ({
  name: key,
  valueFrom: pulumi.interpolate`${arn}:${key}::`,
});

// ─── Daemon Task Definition ───────────────────────────────────────────────────
const daemonTd = new aws.ecs.TaskDefinition("daemon-td", {
  family: "tiwi-daemon",
  cpu: "1024", memory: "2048",
  networkMode: "awsvpc",
  requiresCompatibilities: ["FARGATE"],
  executionRoleArn: executionRole.arn,
  taskRoleArn: taskRole.arn,
  containerDefinitions: pulumi.jsonStringify([{
    name: "daemon",
    image: daemonImage.imageUri,
    environment: [
      { name: "NODE_ENV",                   value: "production" },
      { name: "REDIS_URL",                  value: redisUrl },
      { name: "S3_BUCKET",                  value: filesBucket.id },
      { name: "S3_REGION",                  value: region.name },
      { name: "OPENAI_EMBEDDING_MODEL",     value: "text-embedding-3-small" },
      { name: "OPENAI_SUMMARIZATION_MODEL", value: "gpt-4o-mini" },
    ],
    secrets: [
      secretRef(neo4jSecret.arn,      "NEO4J_URI"),
      secretRef(neo4jSecret.arn,      "NEO4J_USERNAME"),
      secretRef(neo4jSecret.arn,      "NEO4J_PASSWORD"),
      secretRef(openAiSecret.arn,     "OPENAI_API_KEY"),
      secretRef(assemblyAiSecret.arn, "ASSEMBLYAI_API_KEY"),
    ],
    logConfiguration: {
      logDriver: "awslogs",
      options: {
        "awslogs-group":         daemonLogGroup.name,
        "awslogs-region":        region.name,
        "awslogs-stream-prefix": "daemon",
      },
    },
  }]),
});

// ─── ECS Service ──────────────────────────────────────────────────────────────
new aws.ecs.Service("daemon", {
  name: "tiwi-daemon",
  cluster: cluster.id,
  taskDefinition: daemonTd.arn,
  desiredCount: 1,
  launchType: "FARGATE",
  networkConfiguration: {
    assignPublicIp: false,
    subnets: vpc.privateSubnetIds,
    securityGroups: [daemonSg.id],
  },
  deploymentCircuitBreaker: { enable: true, rollback: true },
});

// ─── Outputs ──────────────────────────────────────────────────────────────────
export const s3BucketName        = filesBucket.id;
export const clusterName         = cluster.name;
export const daemonEcrUri        = daemonRepo.repositoryUrl;
// Add these to Vercel environment variables:
export const vercelS3AccessKeyId     = vercelAccessKey.id;
export const vercelS3SecretAccessKey = vercelAccessKey.secret;
