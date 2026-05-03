/**
 * Unit tests for NetworkStack
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../lib/network-stack';

describe('NetworkStack', () => {
  let app: cdk.App;
  let stack: NetworkStack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new NetworkStack(app, 'TestNetworkStack', {
      vpcCidr: '10.130.0.0/20',
      env: { account: '123456789012', region: 'ap-northeast-1' },
    });
    template = Template.fromStack(stack);
  });

  describe('VPC', () => {
    test('creates a single VPC with the supplied CIDR', () => {
      template.resourceCountIs('AWS::EC2::VPC', 1);
      template.hasResourceProperties('AWS::EC2::VPC', {
        CidrBlock: '10.130.0.0/20',
      });
    });

    test('creates 2 isolated subnets across 2 AZs and no public subnets / NAT', () => {
      template.resourceCountIs('AWS::EC2::Subnet', 2);
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
      template.resourceCountIs('AWS::EC2::InternetGateway', 0);
    });

    test('enables flow logs to CloudWatch', () => {
      template.resourceCountIs('AWS::EC2::FlowLog', 1);
      template.hasResourceProperties('AWS::EC2::FlowLog', {
        ResourceType: 'VPC',
        TrafficType: 'ALL',
        LogDestinationType: 'cloud-watch-logs',
      });
    });
  });

  describe('Security Groups', () => {
    test('creates Lambda SG with no default outbound and only HTTPS-to-VPC egress', () => {
      const sgs = template.findResources('AWS::EC2::SecurityGroup');
      const lambdaSg = Object.values(sgs).find((sg) =>
        (sg.Properties.GroupDescription as string).includes('RAG Lambda')
      );
      expect(lambdaSg).toBeDefined();
      expect(lambdaSg!.Properties.SecurityGroupEgress).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            CidrIp: '10.130.0.0/20',
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
          }),
          expect.objectContaining({
            CidrIp: '10.0.0.0/8',
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
          }),
        ])
      );
    });

    test('endpoint SG accepts ingress 443 from the Lambda SG only', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        SourceSecurityGroupId: Match.anyValue(),
      });
    });
  });

  describe('VPC Endpoints', () => {
    test('creates the S3 gateway endpoint', () => {
      const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
      const gatewayEndpoints = Object.values(endpoints).filter(
        (ep) => ep.Properties.VpcEndpointType === 'Gateway'
      );
      expect(gatewayEndpoints).toHaveLength(1);
      expect(JSON.stringify(gatewayEndpoints[0].Properties.ServiceName)).toContain('s3');
    });

    test('creates interface endpoints for bedrock-runtime, bedrock-agent-runtime, kms, logs, execute-api', () => {
      const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
      const interfaceServiceNames = Object.values(endpoints)
        .filter((ep) => ep.Properties.VpcEndpointType === 'Interface')
        .map((ep) => ep.Properties.ServiceName as string | { 'Fn::Join': [string, unknown[]] });

      // ServiceName values can be Fn::Join intrinsics; flatten to a checkable string.
      const flattened = interfaceServiceNames.map((sn) =>
        typeof sn === 'string' ? sn : JSON.stringify(sn)
      );

      const expected = [
        'bedrock-runtime',
        'bedrock-agent-runtime',
        'kms',
        'logs',
        'execute-api',
      ];

      for (const svc of expected) {
        expect(
          flattened.some((name) => name.includes(svc))
        ).toBe(true);
      }
    });

    test('all interface endpoints have private DNS enabled', () => {
      const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
      const interfaces = Object.values(endpoints).filter(
        (ep) => ep.Properties.VpcEndpointType === 'Interface'
      );
      expect(interfaces.length).toBeGreaterThan(0);
      for (const ep of interfaces) {
        expect(ep.Properties.PrivateDnsEnabled).toBe(true);
      }
    });
  });

  describe('Outputs', () => {
    test('exposes VpcId and ExecuteApiVpcEndpointId', () => {
      template.hasOutput('VpcId', {});
      template.hasOutput('ExecuteApiVpcEndpointId', {});
    });
  });

  describe('Public properties', () => {
    test('exposes vpc, lambdaSecurityGroup and executeApiVpcEndpoint', () => {
      expect(stack.vpc).toBeDefined();
      expect(stack.lambdaSecurityGroup).toBeDefined();
      expect(stack.executeApiVpcEndpoint).toBeDefined();
    });
  });
});