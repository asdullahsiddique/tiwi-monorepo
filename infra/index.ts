import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

// ─── Config / Secrets ─────────────────────────────────────────────────────────
// Set these with:
//   pulumi config set     tiwi:clerkPublishableKey  pk_live_...
//   pulumi config set --secret tiwi:clerkSecretKey       sk_live_...
//   pulumi config set --secret tiwi:openAiApiKey         sk-...
//   pulumi config set --secret tiwi:neo4jUri             neo4j+s://...
//   pulumi config set --secret tiwi:neo4jPassword        ...
//   pulumi config set --secret tiwi:assemblyAiApiKey     ...   (optional)
const cfg = new pulumi.Config("tiwi");

const clerkPublishableKey = cfg.require("clerkPublishableKey");       // baked into Docker build
const clerkSecretKey      = cfg.requireSecret("clerkSecretKey");
const openAiApiKey        = cfg.requireSecret("openAiApiKey");
const neo4jUri            = cfg.requireSecret("neo4jUri");
const neo4jPassword       = cfg.requireSecret("neo4jPassword");
const assemblyAiApiKey    = cfg.getSecret("assemblyAiApiKey") ?? pulumi.output("");

// ─── AWS context ──────────────────────────────────────────────────────────────
const region   = aws.getRegionOutput();
const identity = aws.getCallerIdentityOutput();

// ─── VPC ──────────────────────────────────────────────────────────────────────
const vpc = new awsx.ec2.Vpc("tiwi", {
  numberOfAvailabilityZones: 2,
  natGateways: { strategy: "Single" }, // one NAT GW shared across both AZs
  tags: { Name: "tiwi" },
});

// ─── Security Groups ──────────────────────────────────────────────────────────
const albSg = new aws.ec2.SecurityGroup("alb-sg", {
  vpcId: vpc.vpcId,
  description: "ALB — HTTP:80 from internet (Cloudflare terminates HTTPS)",
  ingress: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] }],
  egress:  [{ protocol: "-1",  fromPort: 0,  toPort: 0,  cidrBlocks: ["0.0.0.0/0"] }],
  tags: { Name: "tiwi-alb" },
});

const ecsSg = new aws.ec2.SecurityGroup("ecs-sg", {
  vpcId: vpc.vpcId,
  description: "ECS tasks — inbound from ALB, all outbound",
  ingress: [{ protocol: "tcp", fromPort: 3000, toPort: 3000, securityGroups: [albSg.id] }],
  egress:  [{ protocol: "-1",  fromPort: 0,   toPort: 0,    cidrBlocks: ["0.0.0.0/0"] }],
  tags: { Name: "tiwi-ecs" },
});

const redisSg = new aws.ec2.SecurityGroup("redis-sg", {
  vpcId: vpc.vpcId,
  description: "ElastiCache Redis — inbound from ECS only",
  ingress: [{ protocol: "tcp", fromPort: 6379, toPort: 6379, securityGroups: [ecsSg.id] }],
  tags: { Name: "tiwi-redis" },
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
    allowedOrigins: ["*"], // tighten to your domain once live
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

// ─── ElastiCache Redis ────────────────────────────────────────────────────────
const redisSubnetGroup = new aws.elasticache.SubnetGroup("redis-subnet-group", {
  name: "tiwi-redis",
  subnetIds: vpc.privateSubnetIds,
});

const redis = new aws.elasticache.Cluster("redis", {
  clusterId: "tiwi-redis",
  engine: "redis",
  engineVersion: "7.1",
  nodeType: "cache.t4g.micro",
  numCacheNodes: 1,
  subnetGroupName: redisSubnetGroup.name,
  securityGroupIds: [redisSg.id],
});

const redisAddress = redis.cacheNodes.apply(n => n[0].address);
const redisPort    = redis.cacheNodes.apply(n => n[0].port);
const redisUrl     = pulumi.interpolate`redis://${redisAddress}:${redisPort}`;

// ─── ECR Repositories ─────────────────────────────────────────────────────────
function ecrRepo(name: string, repoName: string): aws.ecr.Repository {
  const repo = new aws.ecr.Repository(name, {
    name: repoName,
    imageTagMutability: "MUTABLE",
    imageScanningConfiguration: { scanOnPush: false },
    tags: { Name: repoName },
  });
  new aws.ecr.LifecyclePolicy(`${name}-lifecycle`, {
    repository: repo.name,
    policy: JSON.stringify({
      rules: [{
        rulePriority: 1, description: "Keep last 10 images",
        selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 10 },
        action: { type: "expire" },
      }],
    }),
  });
  return repo;
}

const frontofficeRepo = ecrRepo("frontoffice-repo", "tiwi/frontoffice");
const daemonRepo      = ecrRepo("daemon-repo",      "tiwi/daemon");

// Build + push Docker images during `pulumi up` (awsx.ecr.Image uses docker build/push).
// awsx respects .dockerignore and only rebuilds when the context hash changes.
const frontofficeImage = new awsx.ecr.Image("frontoffice-image", {
  repositoryUrl: frontofficeRepo.repositoryUrl,
  context: "../",
  dockerfile: "../apps/frontoffice/Dockerfile",
  platform: "linux/amd64",
  args: { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: clerkPublishableKey },
});

const daemonImage = new awsx.ecr.Image("daemon-image", {
  repositoryUrl: daemonRepo.repositoryUrl,
  context: "../",
  dockerfile: "../apps/daemon/Dockerfile",
  platform: "linux/amd64",
});

// ─── Secrets Manager ─────────────────────────────────────────────────────────
// Values come from `pulumi config set --secret` — no manual AWS console steps.
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
  "neo4j-secret", "tiwi/neo4j",
  pulumi.jsonStringify({ NEO4J_URI: neo4jUri, NEO4J_USERNAME: "neo4j", NEO4J_PASSWORD: neo4jPassword }),
);

const clerkSecret = smSecret(
  "clerk-secret", "tiwi/clerk",
  pulumi.jsonStringify({ CLERK_SECRET_KEY: clerkSecretKey }),
);

const openAiSecret = smSecret(
  "openai-secret", "tiwi/openai",
  pulumi.jsonStringify({ OPENAI_API_KEY: openAiApiKey }),
);

const assemblyAiSecret = smSecret(
  "assemblyai-secret", "tiwi/assemblyai",
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
      Resource: [neo4jSecret.arn, clerkSecret.arn, openAiSecret.arn, assemblyAiSecret.arn],
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

// ─── ECS Cluster ──────────────────────────────────────────────────────────────
const cluster = new aws.ecs.Cluster("cluster", {
  name: "tiwi",
  settings: [{ name: "containerInsights", value: "enabled" }],
});

// ─── CloudWatch Logs ──────────────────────────────────────────────────────────
const frontofficeLogGroup = new aws.cloudwatch.LogGroup("frontoffice-logs", {
  name: "/ecs/tiwi/frontoffice",
  retentionInDays: 7,
});

const daemonLogGroup = new aws.cloudwatch.LogGroup("daemon-logs", {
  name: "/ecs/tiwi/daemon",
  retentionInDays: 7,
});

// ─── ALB ──────────────────────────────────────────────────────────────────────
// HTTP only — Cloudflare terminates HTTPS and proxies here.
// After deploy, add a CNAME in Cloudflare pointing to `albDns` output.
const alb = new aws.lb.LoadBalancer("alb", {
  name: "tiwi-alb",
  internal: false,
  loadBalancerType: "application",
  subnets: vpc.publicSubnetIds,
  securityGroups: [albSg.id],
  tags: { Name: "tiwi-alb" },
});

const targetGroup = new aws.lb.TargetGroup("frontoffice-tg", {
  name: "tiwi-frontoffice",
  port: 3000, protocol: "HTTP", targetType: "ip",
  vpcId: vpc.vpcId,
  healthCheck: {
    path: "/", matcher: "200-399",
    healthyThreshold: 2, unhealthyThreshold: 3,
    interval: 30, timeout: 5,
  },
  deregistrationDelay: 30,
  tags: { Name: "tiwi-frontoffice" },
});

const listener = new aws.lb.Listener("http-listener", {
  loadBalancerArn: alb.arn,
  port: 80, protocol: "HTTP",
  defaultActions: [{ type: "forward", targetGroupArn: targetGroup.arn }],
});

// ─── Helper: ECS secret reference from Secrets Manager JSON key ───────────────
const secretRef = (arn: pulumi.Output<string>, key: string) => ({
  name: key,
  valueFrom: pulumi.interpolate`${arn}:${key}::`,
});

// ─── Frontoffice Task Definition ──────────────────────────────────────────────
const frontofficeTd = new aws.ecs.TaskDefinition("frontoffice-td", {
  family: "tiwi-frontoffice",
  cpu: "512", memory: "1024",
  networkMode: "awsvpc",
  requiresCompatibilities: ["FARGATE"],
  executionRoleArn: executionRole.arn,
  taskRoleArn: taskRole.arn,
  containerDefinitions: pulumi.jsonStringify([{
    name: "frontoffice",
    image: frontofficeImage.imageUri,
    portMappings: [{ containerPort: 3000, hostPort: 3000, protocol: "tcp" }],
    environment: [
      { name: "NODE_ENV",                    value: "production" },
      { name: "PORT",                        value: "3000" },
      { name: "REDIS_URL",                   value: redisUrl },
      { name: "S3_BUCKET",                   value: filesBucket.id },
      { name: "S3_REGION",                   value: region.name },
      { name: "OPENAI_EMBEDDING_MODEL",      value: "text-embedding-3-small" },
      { name: "OPENAI_SUMMARIZATION_MODEL",  value: "gpt-4o-mini" },
      { name: "OPENAI_SEARCH_MODEL",         value: "gpt-4o-mini" },
    ],
    secrets: [
      secretRef(neo4jSecret.arn,  "NEO4J_URI"),
      secretRef(neo4jSecret.arn,  "NEO4J_USERNAME"),
      secretRef(neo4jSecret.arn,  "NEO4J_PASSWORD"),
      secretRef(clerkSecret.arn,  "CLERK_SECRET_KEY"),
      secretRef(openAiSecret.arn, "OPENAI_API_KEY"),
    ],
    logConfiguration: {
      logDriver: "awslogs",
      options: {
        "awslogs-group":         frontofficeLogGroup.name,
        "awslogs-region":        region.name,
        "awslogs-stream-prefix": "frontoffice",
      },
    },
  }]),
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

// ─── ECS Services ─────────────────────────────────────────────────────────────
new aws.ecs.Service("frontoffice", {
  name: "tiwi-frontoffice",
  cluster: cluster.id,
  taskDefinition: frontofficeTd.arn,
  desiredCount: 1,
  launchType: "FARGATE",
  networkConfiguration: {
    assignPublicIp: false,
    subnets: vpc.privateSubnetIds,
    securityGroups: [ecsSg.id],
  },
  loadBalancers: [{ targetGroupArn: targetGroup.arn, containerName: "frontoffice", containerPort: 3000 }],
  deploymentCircuitBreaker: { enable: true, rollback: true },
}, { dependsOn: [listener] });

new aws.ecs.Service("daemon", {
  name: "tiwi-daemon",
  cluster: cluster.id,
  taskDefinition: daemonTd.arn,
  desiredCount: 1,
  launchType: "FARGATE",
  networkConfiguration: {
    assignPublicIp: false,
    subnets: vpc.privateSubnetIds,
    securityGroups: [ecsSg.id],
  },
  deploymentCircuitBreaker: { enable: true, rollback: true },
});

// ─── Outputs ──────────────────────────────────────────────────────────────────
export const albDns           = alb.dnsName;
export const s3BucketName     = filesBucket.id;
export const clusterName      = cluster.name;
export const frontofficeEcrUri = frontofficeRepo.repositoryUrl;
export const daemonEcrUri     = daemonRepo.repositoryUrl;
