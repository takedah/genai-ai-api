import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Properties for NetworkStack
 */
export interface NetworkStackProps extends StackProps {
  /** CIDR block for the VPC (e.g. "10.130.0.0/20") */
  readonly vpcCidr: string;
}

/**
 * Stack that provisions the private network used by all RAG APIs.
 *
 * - VPC with private (isolated) subnets only across 2 AZs
 * - Security groups for Lambda and VPC interface endpoints
 * - Interface endpoints for Bedrock, KMS, CloudWatch Logs, and execute-api
 * - Gateway endpoint for S3
 *
 * No NAT gateway and no public subnets — all egress goes through VPC endpoints.
 */
export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  public readonly executeApiVpcEndpoint: ec2.InterfaceVpcEndpoint;

  // Hard-code AZs to avoid an AWS context lookup during synth.
  // Deploy region is fixed to ap-northeast-1 in bin/qe-rag-apis.ts.
  get availabilityZones(): string[] {
    return ['ap-northeast-1a', 'ap-northeast-1c'];
  }

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    // VPC: private isolated subnets only, across 2 AZs
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 22,
        },
      ],
      // VPC flow logs to CloudWatch
      flowLogs: {
        toCloudWatch: {
          trafficType: ec2.FlowLogTrafficType.ALL,
          destination: ec2.FlowLogDestination.toCloudWatchLogs(),
        },
      },
    });

    // Security group attached to the Lambda functions.
    // Egress 443 only — outbound traffic targets VPC endpoints.
    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'Security group for RAG Lambda functions',
      allowAllOutbound: false,
    });
    this.lambdaSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(props.vpcCidr),
      ec2.Port.tcp(443),
      'HTTPS to VPC endpoints'
    );
    this.lambdaSecurityGroup.addEgressRule(
      ec2.Peer.ipv4('10.0.0.0/8'),
      ec2.Port.tcp(443),
      'HTTPS to on-premises networks via VPN/Direct Connect'
    );

    // Security group for VPC interface endpoints.
    // Inbound 443 from the Lambda security group only.
    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: this.vpc,
      description: 'Security group for VPC interface endpoints',
      allowAllOutbound: false,
    });
    endpointSg.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(443),
      'HTTPS from Lambda SG'
    );

    // Gateway endpoint for S3 (free, attached via route tables)
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    const interfaceEndpointDefaults = {
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    };

    // Bedrock runtime — Converse API
    this.vpc.addInterfaceEndpoint('BedrockRuntimeEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      ...interfaceEndpointDefaults,
    });

    // Bedrock agent runtime — Knowledge Base Retrieve / RetrieveAndGenerate
    this.vpc.addInterfaceEndpoint('BedrockAgentRuntimeEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_AGENT_RUNTIME,
      ...interfaceEndpointDefaults,
    });

    // KMS — encryption operations against CMEK
    this.vpc.addInterfaceEndpoint('KmsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.KMS,
      ...interfaceEndpointDefaults,
    });

    // CloudWatch Logs — Lambda log delivery
    this.vpc.addInterfaceEndpoint('LogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      ...interfaceEndpointDefaults,
    });

    // execute-api — Private API Gateway invocation entry point
    this.executeApiVpcEndpoint = this.vpc.addInterfaceEndpoint(
      'ExecuteApiEndpoint',
      {
        service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
        ...interfaceEndpointDefaults,
      }
    );

    new CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID hosting the private RAG network',
    });

    new CfnOutput(this, 'ExecuteApiVpcEndpointId', {
      value: this.executeApiVpcEndpoint.vpcEndpointId,
      description: 'VPC endpoint ID used to invoke the private API Gateway',
    });

    NagSuppressions.addResourceSuppressions(
      this.vpc,
      [
        {
          id: 'AwsSolutions-VPC7',
          reason: 'VPC flow logs are enabled via the flowLogs option',
        },
      ],
      true
    );

    // EndpointSg only accepts ingress from the Lambda SG, but cdk-nag cannot
    // resolve the source SG ID at synth time and emits a false-positive warning.
    NagSuppressions.addResourceSuppressions(endpointSg, [
      {
        id: 'CdkNagValidationFailure',
        reason:
          'Ingress is restricted to the Lambda security group via SG reference; cdk-nag cannot resolve the SG token at synth time',
      },
    ]);
  }
}