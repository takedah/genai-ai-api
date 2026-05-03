import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { RagLambda } from './constructs/rag-lambda';

/**
 * API throttle and quota settings
 */
const API_THROTTLE_CONFIG = {
  burstLimit: 100,
  rateLimit: 1000,
};

const API_QUOTA_CONFIG = {
  limit: 1000,
  period: apigateway.Period.DAY,
};

/**
 * Properties for RagLambdaApiStack
 */
interface RagLambdaApiStackProps extends StackProps {
  /** Application name identifier */
  readonly appName: string;
  /** Bedrock Knowledge Base ID */
  readonly knowledgeBaseId: string;
  /** IAM role for switch role access */
  readonly switchRole: iam.Role;
  /** Lambda log level */
  readonly logLevel: string;
  /** Application parameter file name */
  readonly appParamFile: string;
  /** KMS key for encryption */
  readonly encryptionKey: kms.IKey;
  /** Lambda integration timeout in seconds */
  readonly apiLambdaIntegrationTimeout: number;
  /** Bedrock regions allowed for model invocation (defaults to deploy region if not specified) */
  readonly bedrockRegions?: string[];
  /** VPC for the Lambda function */
  readonly vpc: ec2.IVpc;
  /** Security group for the Lambda function */
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;
  /** VPC endpoint for execute-api — used to restrict the Private API */
  readonly executeApiVpcEndpoint: ec2.IInterfaceVpcEndpoint;
}

/**
 * Stack for RAG Lambda API with API Gateway
 */
export class RagLambdaApiStack extends Stack {
  constructor(scope: Construct, id: string, props: RagLambdaApiStackProps) {
    super(scope, id, props);

    // Create RAG Lambda function (VPC-attached)
    const ragFunction = new RagLambda(this, 'RagLambda', {
      knowledgeBaseId: props.knowledgeBaseId,
      appName: props.appName,
      logLevel: props.logLevel,
      appParamFile: props.appParamFile,
      encryptionKey: props.encryptionKey,
      bedrockRegions: props.bedrockRegions,
      vpc: props.vpc,
      securityGroup: props.lambdaSecurityGroup,
    });

    // Create Private API Gateway REST API restricted to the execute-api VPC endpoint
    const restApi = this.createRestApi(
      props.appName,
      props.encryptionKey,
      props.executeApiVpcEndpoint
    );

    // Configure usage plan and API key
    const { apiKey } = this.configureApiAccess(restApi, props.appName);

    // Add gateway responses for CORS
    this.addGatewayResponses(restApi);

    // Create POST /invoke endpoint
    const invokeEndpoint = this.createInvokeEndpoint(
      restApi,
      ragFunction,
      props.apiLambdaIntegrationTimeout
    );

    // Grant switch role permissions
    this.grantSwitchRolePermissions(props.switchRole, ragFunction, apiKey);

    // Create stack outputs
    this.createOutputs(restApi, apiKey, props.switchRole);

    // Apply CDK-NAG suppressions
    this.applyNagSuppressions(restApi, invokeEndpoint);
  }

  /**
   * Create Private REST API with logging and CORS, restricted via resource policy
   * to the supplied execute-api VPC endpoint.
   */
  private createRestApi(
    appName: string,
    encryptionKey: kms.IKey,
    executeApiVpcEndpoint: ec2.IInterfaceVpcEndpoint
  ): apigateway.RestApi {
    const accessLogGroup = new logs.LogGroup(this, `${appName}-ApiGatewayLogGroup`, {
      encryptionKey: encryptionKey,
      removalPolicy: RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // Resource policy: deny everything not coming through the designated VPC endpoint.
    const resourcePolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.AnyPrincipal()],
          actions: ['execute-api:Invoke'],
          resources: ['execute-api:/*'],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ['execute-api:Invoke'],
          resources: ['execute-api:/*'],
          conditions: {
            StringNotEquals: {
              'aws:SourceVpce': executeApiVpcEndpoint.vpcEndpointId,
            },
          },
        }),
      ],
    });

    return new apigateway.RestApi(this, `${appName}-RagApi`, {
      endpointConfiguration: {
        types: [apigateway.EndpointType.PRIVATE],
        vpcEndpoints: [executeApiVpcEndpoint],
      },
      policy: resourcePolicy,
      deployOptions: {
        dataTraceEnabled: true,
        metricsEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
      },
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: RemovalPolicy.DESTROY,
      apiKeySourceType: apigateway.ApiKeySourceType.HEADER,
    });
  }

  /**
   * Configure API usage plan and API key
   */
  private configureApiAccess(
    api: apigateway.RestApi,
    appName: string
  ): { usagePlan: apigateway.UsagePlan; apiKey: apigateway.IApiKey } {
    const usagePlan = api.addUsagePlan(`${appName}-RagApiUsagePlan`, {
      throttle: API_THROTTLE_CONFIG,
      quota: API_QUOTA_CONFIG,
      apiStages: [{ api, stage: api.deploymentStage }],
    });

    const apiKey = api.addApiKey(`${appName}-RagApiKey`);
    usagePlan.addApiKey(apiKey);
    usagePlan.applyRemovalPolicy(RemovalPolicy.DESTROY);

    return { usagePlan, apiKey };
  }

  /**
   * Add gateway responses for error handling with CORS headers
   */
  private addGatewayResponses(api: apigateway.RestApi): void {
    const corsHeaders = { 'Access-Control-Allow-Origin': "'*'" };

    api.addGatewayResponse('Api4XX', {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: corsHeaders,
    });

    api.addGatewayResponse('Api5XX', {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: corsHeaders,
    });
  }

  /**
   * Create POST /invoke endpoint with Lambda integration
   */
  private createInvokeEndpoint(
    api: apigateway.RestApi,
    ragLambda: RagLambda,
    timeoutSeconds: number
  ): apigateway.Resource {
    const invokeResource = api.root.addResource('invoke');

    invokeResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(ragLambda.lambda, {
        timeout: Duration.seconds(timeoutSeconds),
      }),
      { apiKeyRequired: true }
    );

    return invokeResource;
  }

  /**
   * Grant switch role permissions for Lambda invocation and API key retrieval
   */
  private grantSwitchRolePermissions(
    switchRole: iam.Role,
    ragLambda: RagLambda,
    apiKey: apigateway.IApiKey
  ): void {
    const apiKeyArn = `arn:aws:apigateway:${this.region}::/apikeys/${apiKey.keyId}`;

    const devPolicy = new iam.Policy(this, 'RagDevelopPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [ragLambda.lambda.functionArn],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [ragLambda.lambda.role!.roleArn],
        }),
        // Allow retrieving the API key value via:
        // aws apigateway get-api-key --api-key <KEY_ID> --include-value
        new iam.PolicyStatement({
          actions: ['apigateway:GET'],
          resources: [apiKeyArn],
        }),
      ],
    });

    switchRole.attachInlinePolicy(devPolicy);
  }

  /**
   * Create CloudFormation outputs
   */
  private createOutputs(
    api: apigateway.RestApi,
    apiKey: apigateway.IApiKey,
    switchRole: iam.Role
  ): void {
    new CfnOutput(this, 'ApiEndpoint', {
      value: `${api.url}invoke`,
      description: 'API Gateway Endpoint URL',
    });

    new CfnOutput(this, 'SwitchRole', {
      value: switchRole.roleName,
      description: 'Role name for development',
    });

    new CfnOutput(this, 'ApiKeyId', {
      value: apiKey.keyId,
      description:
        'API Key ID for retrieving the API key value using AWS CLI: aws apigateway get-api-key --api-key <KEY_ID> --include-value',
    });
  }

  /**
   * Apply CDK-NAG suppressions for required permissions
   */
  private applyNagSuppressions(
    api: apigateway.RestApi,
    invokeResource: apigateway.Resource
  ): void {
    NagSuppressions.addResourceSuppressions(
      api,
      [
        {
          id: 'AwsSolutions-APIG2',
          reason:
            'Request validation is implemented in the Lambda function with comprehensive input validation and error handling',
        },
        {
          id: 'AwsSolutions-APIG3',
          reason:
            'Private API Gateway accessed only via execute-api VPC endpoint; access is restricted by resource policy on aws:SourceVpce instead of WAFv2 (WAFv2 is not supported on Private REST APIs)',
        },
      ],
      true
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/${api.node.id}/CloudWatchRole/Resource`,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'CloudWatch role requires managed policy for API Gateway logging',
        },
      ]
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/${api.node.id}/Default/${invokeResource.node.id}/POST/Resource`,
      [
        {
          id: 'AwsSolutions-COG4',
          reason: 'API Key authentication is used instead of Cognito',
        },
        {
          id: 'AwsSolutions-APIG4',
          reason: 'API Key authentication is configured for this endpoint',
        },
      ]
    );
  }
}
