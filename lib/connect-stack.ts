import * as connect from 'aws-cdk-lib/aws-connect';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

const SANDBOX_PARAMETER_PREFIX = '/connect/sandbox';

interface ContactFlowError {
  ErrorType: 'NoMatchingError';
  NextAction: string;
}

interface ContactFlowAction {
  Identifier: string;
  Type: string;
  Parameters: Record<string, string>;
  Transitions: {
    NextAction?: string;
    Errors?: ContactFlowError[];
    Conditions?: [];
  };
}

interface ContactFlowContent {
  Version: '2019-10-30';
  StartAction: string;
  Metadata: {
    entryPointPosition: { x: number; y: number };
    ActionMetadata: Record<string, { position: { x: number; y: number } }>;
  };
  Actions: ContactFlowAction[];
}

const mainFlow: ContactFlowContent = {
  Version: '2019-10-30',
  StartAction: 'set-voice',
  Metadata: {
    entryPointPosition: { x: 40, y: 40 },
    ActionMetadata: {
      'set-voice': { position: { x: 290, y: 40 } },
      'play-greeting': { position: { x: 540, y: 40 } },
      disconnect: { position: { x: 790, y: 40 } },
    },
  },
  Actions: [
    {
      Identifier: 'set-voice',
      Type: 'UpdateContactTextToSpeechVoice',
      Parameters: {
        TextToSpeechVoice: 'Joanna',
        TextToSpeechEngine: 'Neural',
      },
      Transitions: {
        NextAction: 'play-greeting',
        Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'disconnect' }],
        Conditions: [],
      },
    },
    {
      Identifier: 'play-greeting',
      Type: 'MessageParticipant',
      Parameters: {
        Text: 'Thank you for calling Harbor Ridge 3 1 1. This line is a demo. Goodbye.',
      },
      Transitions: {
        NextAction: 'disconnect',
        Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'disconnect' }],
        Conditions: [],
      },
    },
    {
      Identifier: 'disconnect',
      Type: 'DisconnectParticipant',
      Parameters: {},
      Transitions: {},
    },
  ],
};

export class ConnectStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const instanceArn = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/instance-arn`,
    );
    const instanceId = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/instance-id`,
    );
    const phoneNumberArn = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/phone-number-arn`,
    );
    const phoneNumber = ssm.StringParameter.valueForStringParameter(
      this,
      `${SANDBOX_PARAMETER_PREFIX}/phone-number`,
    );

    const flow = new connect.CfnContactFlow(this, 'MainFlow', {
      instanceArn,
      name: 'HarborRidge311-Main',
      type: 'CONTACT_FLOW',
      content: JSON.stringify(mainFlow),
    });

    const associateCall: cr.AwsSdkCall = {
      service: 'connect',
      action: 'AssociatePhoneNumberContactFlow',
      parameters: {
        PhoneNumberId: phoneNumberArn,
        InstanceId: instanceId,
        ContactFlowId: flow.attrContactFlowArn,
      },
      physicalResourceId: cr.PhysicalResourceId.of('HarborRidge311-Main'),
    };

    new cr.AwsCustomResource(this, 'AssociatePhoneNumber', {
      onCreate: associateCall,
      onUpdate: associateCall,
      onDelete: {
        service: 'connect',
        action: 'DisassociatePhoneNumberContactFlow',
        parameters: {
          PhoneNumberId: phoneNumberArn,
          InstanceId: instanceId,
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['connect:AssociatePhoneNumberContactFlow'],
          resources: [instanceArn, flow.attrContactFlowArn, phoneNumberArn],
        }),
        new iam.PolicyStatement({
          actions: ['connect:DisassociatePhoneNumberContactFlow'],
          resources: [instanceArn, phoneNumberArn],
        }),
      ]),
    });

    new cdk.CfnOutput(this, 'ContactFlowArn', {
      value: flow.attrContactFlowArn,
      description: 'ARN of the Harbor Ridge 311 main contact flow',
    });

    new cdk.CfnOutput(this, 'PhoneNumber', {
      value: phoneNumber,
      description: 'Sandbox phone number associated with the main contact flow',
    });
  }
}
