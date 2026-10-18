# Harbor Ridge 311

Portfolio demo of a fictional city 311 line. `WebsiteStack` is the static site. `ConnectStack` is the phone demo on the existing Amazon Connect sandbox instance.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## ConnectStack

`ConnectStack` reads the sandbox instance published by [connect-platform](https://github.com/ckreidler/connect-platform) and adds a contact flow named `HarborRidge311-Main` plus a data table named `HarborRidge311-Prompts`. The flow asks the caller to press 1 for English or 2 for Spanish, sets the voice and contact language, then plays the greeting for that language from the table. The caller can then ask about trash pickup, potholes, parking permits, or office hours. Answers come from Amazon Q in Connect, using FAQ documents in a private S3 bucket. The Lex bot has English (US) and Spanish (US) locales. Answer text uses the default English system prompts, so a Spanish caller is recognized but the generated answer is not localized. Saying agent, or any path that does not finish the question, plays the goodbye from the table and hangs up. There is no human queue. A lookup error plays a hardcoded English fallback and hangs up. A custom resource calls `AssociatePhoneNumberContactFlow` so the sandbox number uses this flow, and `DisassociatePhoneNumberContactFlow` when the stack is deleted.

The Q in Connect assistant is owned by connect-platform. This stack reads that assistant and associates the Harbor Ridge FAQ knowledge base and the Lex bot with the shared sandbox instance.

SSM parameters, read at deploy time with `StringParameter.valueForStringParameter`:

- `/connect/sandbox/instance-arn`
- `/connect/sandbox/instance-id`
- `/connect/sandbox/phone-number-arn`
- `/connect/sandbox/phone-number`
- `/connect/sandbox/assistant-arn`
- `/connect/sandbox/assistant-id`

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
