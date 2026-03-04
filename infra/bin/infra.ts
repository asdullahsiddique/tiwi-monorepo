#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { TiwiStack } from "../lib/tiwi-stack";

const app = new cdk.App();

new TiwiStack(app, "TiwiStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  tags: {
    Project: "tiwi",
    ManagedBy: "cdk",
  },
});
