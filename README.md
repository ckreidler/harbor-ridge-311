# Harbor Ridge 311

Portfolio demo of a fictional city 311 line. `WebsiteStack` is the static site. `ConnectStack` is the phone demo on the existing Amazon Connect sandbox instance.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## ConnectStack

`ConnectStack` reads the sandbox instance published by [connect-platform](https://github.com/ckreidler/connect-platform) and adds a contact flow named `HarborRidge311-Main` plus a data table named `HarborRidge311-Prompts`. The flow is English only. It sets the contact language to en-US and the Joanna voice, then plays the English greeting from the table. The caller can ask about trash pickup, potholes, parking permits, or office hours. Answers come from two Amazon Q in Connect orchestration agents, one for voice and one for chat, using FAQ documents in a private S3 bucket. The Lex bot has an English (US) locale. A completed answer plays the goodbye from the table. An escalation, or any path that does not finish the question, checks office hours. There is no human queue. A lookup error plays a hardcoded English fallback and hangs up. A custom resource calls `AssociatePhoneNumberContactFlow` so the sandbox number uses this flow, and `DisassociatePhoneNumberContactFlow` when the stack is deleted.

The Q in Connect assistant is owned by connect-platform. This stack reads that assistant and associates the Harbor Ridge FAQ knowledge base and the Lex bot with the shared sandbox instance.

SSM parameters, read at deploy time with `StringParameter.valueForStringParameter`:

- `/connect/sandbox/instance-arn`
- `/connect/sandbox/instance-id`
- `/connect/sandbox/phone-number-arn`
- `/connect/sandbox/phone-number`
- `/connect/sandbox/assistant-arn`
- `/connect/sandbox/assistant-id`
- `/connect/sandbox/cases-domain-id`

The Cases domain stays in connect-platform. This stack adds the Active template `Harbor Ridge 311 Service Request` so an agent can open a case. The layout shows request category, service address, the system summary, and the system customer. Title and category are required. Category choices are Trash pickup, Pothole, Parking permit, and Other.

This app has no stage context. connect-platform only publishes `sandbox`, so those paths live in one constant, `SANDBOX_PARAMETER_PREFIX`, in `lib/connect-stack.ts`.

Deploy `ConnectPlatform-sandbox` in connect-platform first, so the assistant parameters exist. Then deploy `ConnectStack` with credentials for account `945777367807`. The region is your AWS configuration, the same `CDK_DEFAULT_REGION` the platform stack uses:

```bash
npx cdk deploy ConnectStack
```

Outputs are the contact flow ARN, the phone number, the sandbox assistant ARN, and the Lex bot alias ARN.

## Useful commands

* `npm run build`   type-check the project
* `npm run watch`   watch for changes and type-check
* `npm run test`    perform the jest unit tests
* `npx cdk deploy WebsiteStack`  deploy the static site
* `npx cdk deploy ConnectStack`  deploy the contact flow
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
