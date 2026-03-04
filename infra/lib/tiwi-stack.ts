import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export class TiwiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── VPC ──────────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1, // single NAT to save cost (~$32/mo)
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ─── Security Groups ──────────────────────────────────────────────────────
    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc,
      description: "ALB — allow HTTP(S) from internet",
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    const ecsSg = new ec2.SecurityGroup(this, "EcsSg", {
      vpc,
      description: "ECS tasks — allow from ALB",
      allowAllOutbound: true,
    });
    ecsSg.addIngressRule(albSg, ec2.Port.tcp(3000), "Frontoffice from ALB");

    const redisSg = new ec2.SecurityGroup(this, "RedisSg", {
      vpc,
      description: "ElastiCache Redis — allow from ECS only",
      allowAllOutbound: false,
    });
    redisSg.addIngressRule(ecsSg, ec2.Port.tcp(6379), "Redis from ECS");

    // ─── S3 ───────────────────────────────────────────────────────────────────
    const filesBucket = new s3.Bucket(this, "FilesBucket", {
      // Bucket name must be globally unique; account+region suffix ensures that
      bucketName: `tiwi-files-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          // Presigned PUT uploads come directly from the browser
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedOrigins: ["*"], // Restrict to your domain in production
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          id: "abort-incomplete-multipart",
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // ─── ElastiCache Redis ────────────────────────────────────────────────────
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(
      this,
      "RedisSubnetGroup",
      {
        description: "Tiwi Redis subnet group",
        subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
        cacheSubnetGroupName: "tiwi-redis-subnet-group",
      }
    );

    const redis = new elasticache.CfnCacheCluster(this, "Redis", {
      cacheNodeType: "cache.t4g.micro",
      engine: "redis",
      engineVersion: "7.1",
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
    });
    redis.addDependency(redisSubnetGroup);

    const redisUrl = `redis://${redis.attrRedisEndpointAddress}:${redis.attrRedisEndpointPort}`;

    // ─── ECR Repositories ─────────────────────────────────────────────────────
    const frontofficeRepo = new ecr.Repository(this, "FrontofficeRepo", {
      repositoryName: "tiwi/frontoffice",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    const daemonRepo = new ecr.Repository(this, "DaemonRepo", {
      repositoryName: "tiwi/daemon",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    // ─── Secrets Manager ─────────────────────────────────────────────────────
    // After deploying, update each secret via Console or CLI with real values.
    //
    // aws secretsmanager put-secret-value --secret-id tiwi/neo4j \
    //   --secret-string '{"NEO4J_URI":"neo4j+s://...","NEO4J_USERNAME":"neo4j","NEO4J_PASSWORD":"..."}'
    //
    const neo4jSecret = new secretsmanager.Secret(this, "Neo4jSecret", {
      secretName: "tiwi/neo4j",
      description: "Neo4j Aura connection — NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD",
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({
          NEO4J_URI: "REPLACE_ME",
          NEO4J_USERNAME: "neo4j",
          NEO4J_PASSWORD: "REPLACE_ME",
        })
      ),
    });

    const clerkSecret = new secretsmanager.Secret(this, "ClerkSecret", {
      secretName: "tiwi/clerk",
      description: "Clerk auth keys — CLERK_SECRET_KEY (server-side only)",
      // NOTE: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must be baked in as a Docker
      // build arg (--build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...) because
      // Next.js embeds NEXT_PUBLIC_* vars into the client bundle at build time.
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({ CLERK_SECRET_KEY: "REPLACE_ME" })
      ),
    });

    const openAiSecret = new secretsmanager.Secret(this, "OpenAiSecret", {
      secretName: "tiwi/openai",
      description: "OpenAI API key",
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({ OPENAI_API_KEY: "REPLACE_ME" })
      ),
    });

    const assemblyAiSecret = new secretsmanager.Secret(this, "AssemblyAiSecret", {
      secretName: "tiwi/assemblyai",
      description: "AssemblyAI API key (optional — audio/video transcription)",
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({ ASSEMBLYAI_API_KEY: "REPLACE_ME" })
      ),
    });

    // ─── IAM ──────────────────────────────────────────────────────────────────
    // Execution role: ECS agent uses this to pull images and inject secrets
    const executionRole = new iam.Role(this, "EcsExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    });
    for (const secret of [neo4jSecret, clerkSecret, openAiSecret, assemblyAiSecret]) {
      secret.grantRead(executionRole);
    }

    // Task role: the application itself uses this (S3 access via IAM — no static keys)
    const taskRole = new iam.Role(this, "EcsTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    filesBucket.grantReadWrite(taskRole);

    // ─── ECS Cluster ──────────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: "tiwi",
      containerInsights: true,
    });

    // ─── CloudWatch Log Groups ────────────────────────────────────────────────
    const frontofficeLogGroup = new logs.LogGroup(this, "FrontofficeLogGroup", {
      logGroupName: "/ecs/tiwi/frontoffice",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const daemonLogGroup = new logs.LogGroup(this, "DaemonLogGroup", {
      logGroupName: "/ecs/tiwi/daemon",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ─── Frontoffice Task Definition ──────────────────────────────────────────
    const frontofficeTd = new ecs.FargateTaskDefinition(this, "FrontofficeTd", {
      cpu: 512,       // 0.5 vCPU
      memoryLimitMiB: 1024,
      executionRole,
      taskRole,
    });

    frontofficeTd.addContainer("frontoffice", {
      image: ecs.ContainerImage.fromEcrRepository(frontofficeRepo, "latest"),
      portMappings: [{ containerPort: 3000 }],
      environment: {
        NODE_ENV: "production",
        PORT: "3000",
        REDIS_URL: redisUrl,
        // S3 — no access key needed; task role grants access via IAM
        S3_BUCKET: filesBucket.bucketName,
        S3_REGION: this.region,
        // OpenAI model config (non-secret)
        OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
        OPENAI_SUMMARIZATION_MODEL: "gpt-4o-mini",
        OPENAI_SEARCH_MODEL: "gpt-4o-mini",
      },
      secrets: {
        NEO4J_URI: ecs.Secret.fromSecretsManager(neo4jSecret, "NEO4J_URI"),
        NEO4J_USERNAME: ecs.Secret.fromSecretsManager(neo4jSecret, "NEO4J_USERNAME"),
        NEO4J_PASSWORD: ecs.Secret.fromSecretsManager(neo4jSecret, "NEO4J_PASSWORD"),
        CLERK_SECRET_KEY: ecs.Secret.fromSecretsManager(clerkSecret, "CLERK_SECRET_KEY"),
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(openAiSecret, "OPENAI_API_KEY"),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "frontoffice",
        logGroup: frontofficeLogGroup,
      }),
    });

    // ─── Daemon Task Definition ───────────────────────────────────────────────
    const daemonTd = new ecs.FargateTaskDefinition(this, "DaemonTd", {
      cpu: 1024,      // 1 vCPU
      memoryLimitMiB: 2048,
      executionRole,
      taskRole,
    });

    daemonTd.addContainer("daemon", {
      image: ecs.ContainerImage.fromEcrRepository(daemonRepo, "latest"),
      environment: {
        NODE_ENV: "production",
        REDIS_URL: redisUrl,
        S3_BUCKET: filesBucket.bucketName,
        S3_REGION: this.region,
        OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
        OPENAI_SUMMARIZATION_MODEL: "gpt-4o-mini",
      },
      secrets: {
        NEO4J_URI: ecs.Secret.fromSecretsManager(neo4jSecret, "NEO4J_URI"),
        NEO4J_USERNAME: ecs.Secret.fromSecretsManager(neo4jSecret, "NEO4J_USERNAME"),
        NEO4J_PASSWORD: ecs.Secret.fromSecretsManager(neo4jSecret, "NEO4J_PASSWORD"),
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(openAiSecret, "OPENAI_API_KEY"),
        ASSEMBLYAI_API_KEY: ecs.Secret.fromSecretsManager(assemblyAiSecret, "ASSEMBLYAI_API_KEY"),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "daemon",
        logGroup: daemonLogGroup,
      }),
    });

    // ─── ALB ──────────────────────────────────────────────────────────────────
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      loadBalancerName: "tiwi-alb",
    });

    const listener = alb.addListener("HttpListener", {
      port: 80,
      open: true,
    });

    // ─── ECS Services ─────────────────────────────────────────────────────────
    // desiredCount: 0 — scale up after pushing Docker images to ECR
    const frontofficeService = new ecs.FargateService(this, "FrontofficeService", {
      cluster,
      taskDefinition: frontofficeTd,
      desiredCount: 0,
      securityGroups: [ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      serviceName: "tiwi-frontoffice",
      circuitBreaker: { rollback: true },
    });

    listener.addTargets("FrontofficeTarget", {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [frontofficeService],
      healthCheck: {
        path: "/",
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        timeout: cdk.Duration.seconds(5),
        healthyHttpCodes: "200-399",
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    new ecs.FargateService(this, "DaemonService", {
      cluster,
      taskDefinition: daemonTd,
      desiredCount: 0,
      securityGroups: [ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      serviceName: "tiwi-daemon",
      circuitBreaker: { rollback: true },
    });

    // ─── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "AlbDns", {
      value: alb.loadBalancerDnsName,
      description: "Frontoffice URL (add CNAME to your domain)",
    });

    new cdk.CfnOutput(this, "FrontofficeEcrUri", {
      value: frontofficeRepo.repositoryUri,
      description: "docker push <tag> to this URI",
    });

    new cdk.CfnOutput(this, "DaemonEcrUri", {
      value: daemonRepo.repositoryUri,
      description: "docker push <tag> to this URI",
    });

    new cdk.CfnOutput(this, "S3BucketName", {
      value: filesBucket.bucketName,
    });

    new cdk.CfnOutput(this, "RedisEndpoint", {
      value: redisUrl,
    });

    new cdk.CfnOutput(this, "EcsClusterName", {
      value: cluster.clusterName,
    });
  }
}
