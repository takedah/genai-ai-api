/**
 * Unit tests for RagLambdaApiStack (Private API + VPC-attached Lambda)
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { RagLambdaApiStack } from '../../lib/rag-lambda-api-stack';

describe('RagLambdaApiStack', () => {
  let app: cdk.App;
  let supportStack: cdk.Stack;
  let switchRole: iam.Role;
  let encryptionKey: kms.Key;
  let vpc: ec2.IVpc;
  let lambdaSg: ec2.ISecurityGroup;
  let executeApiVpce: ec2.IInterfaceVpcEndpoint;

  beforeEach(() => {
    app = new cdk.App();
    supportStack = new cdk.Stack(app, 'SupportStack', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
    });
    switchRole = new iam.Role(supportStack, 'TestSwitchRole', {
      assumedBy: new iam.AccountPrincipal('123456789012'),
    });
    encryptionKey = new kms.Key(supportStack, 'TestKey');
    vpc = new ec2.Vpc(supportStack, 'TestVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.130.0.0/20'),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 22,
        },
      ],
    });
    lambdaSg = new ec2.SecurityGroup(supportStack, 'TestLambdaSg', {
      vpc,
      allowAllOutbound: false,
    });
    executeApiVpce = vpc.addInterfaceEndpoint('TestExecuteApiVpce', {
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
    });
  });

  function createStack(): cdk.Stack {
    return new RagLambdaApiStack(app, 'TestRagLambdaApiStack', {
      appName: 'test-app',
      knowledgeBaseId: 'kb-test-123',
      switchRole: switchRole,
      logLevel: 'INFO',
      appParamFile: 'test.toml',
      encryptionKey: encryptionKey,
      apiLambdaIntegrationTimeout: 29,
      vpc,
      lambdaSecurityGroup: lambdaSg,
      executeApiVpcEndpoint: executeApiVpce,
      env: { account: '123456789012', region: 'ap-northeast-1' },
    });
  }

  describe('API Gateway', () => {
    test('creates REST API with PRIVATE endpoint bound to the execute-api VPCE', () => {
      const stack = createStack();
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::ApiGateway::RestApi', {
        EndpointConfiguration: Match.objectLike({
          Types: ['PRIVATE'],
        }),
      });

      const restApis = template.findResources('AWS::ApiGateway::RestApi');
      const restApi = Object.values(restApis)[0];
      expect(restApi.Properties.EndpointConfiguration.VpcEndpointIds).toBeDefined();
      expect(restApi.Properties.EndpointConfiguration.VpcEndpointIds).toHaveLength(1);
    });

    test('attaches a resource policy that denies traffic from any other VPCE', () => {
      const stack = createStack();
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::ApiGateway::RestApi', {
        Policy: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Action: 'execute-api:Invoke',
              Condition: {
                StringNotEquals: {
                  'aws:SourceVpce': Match.anyValue(),
                },
              },
            }),
          ]),
        }),
      });

      template.hasResourceProperties('AWS::ApiGateway::RestApi', {
        Policy: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: 'execute-api:Invoke',
            }),
          ]),
        }),
      });
    });

    test('does not associate any WAF WebACL', () => {
      const stack = createStack();
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    });

    test('creates usage plan with throttle settings', () => {
      const stack = createStack();
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
        Throttle: {
          BurstLimit: 100,
          RateLimit: 1000,
        },
        Quota: {
          Limit: 1000,
          Period: 'DAY',
        },
      });
    });

    test('creates API key', () => {
      const stack = createStack();
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::ApiGateway::ApiKey', 1);
    });

    test('creates gateway responses for 4XX and 5XX', () => {
      const stack = createStack();
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::ApiGateway::GatewayResponse', 2);
    });

    test('creates POST /invoke endpoint', () => {
      const stack = createStack();
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'POST',
        ApiKeyRequired: true,
      });

      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'invoke',
      });
    });
  });

  describe('Lambda Integration', () => {
    test('creates Lambda function attached to the supplied VPC and security group', () => {
      const stack = createStack();
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::Lambda::Function', 1);

      const fns = template.findResources('AWS::Lambda::Function');
      const fn = Object.values(fns)[0];
      expect(fn.Properties.VpcConfig).toBeDefined();
      expect(fn.Properties.VpcConfig.SubnetIds.length).toBeGreaterThan(0);
      expect(fn.Properties.VpcConfig.SecurityGroupIds.length).toBeGreaterThan(0);
    });
  });

  describe('CloudWatch Logging', () => {
    test('creates log group for API Gateway', () => {
      const stack = createStack();
      const template = Template.fromStack(stack);

      const resources = template.findResources('AWS::Logs::LogGroup');
      expect(Object.keys(resources).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('SwitchRole Permissions', () => {
    test('grants apigateway:GET on the API key to switch role', () => {
      const stack = createStack();
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'apigateway:GET',
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });
  });

  describe('Stack Outputs', () => {
    test('outputs API endpoint', () => {
      const stack = createStack();
      const template = Template.fromStack(stack);

      template.hasOutput('ApiEndpoint', {});
    });

    test('outputs API key ID', () => {
      const stack = createStack();
      const template = Template.fromStack(stack);

      template.hasOutput('ApiKeyId', {});
    });
  });
});