# Harbor Ridge 311

Portfolio demo of a fictional city 311 line. `WebsiteStack` is the static site. `ConnectStack` is the phone demo on the existing Amazon Connect sandbox instance.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## ConnectStack

`ConnectStack` reads the sandbox instance published by [connect-platform](https://github.com/ckreidler/connect-platform) and adds a contact flow named `HarborRidge311-Main` plus a data table named `HarborRidge311-PromptsByChannel`. The flow is English only. It sets the Joanna voice, then plays the greeting from the table. The caller can ask about trash pickup, potholes, parking permits, or office hours. Answers come from two Amazon Q in Connect orchestration agents, one for voice and one for chat, using FAQ documents in a private S3 bucket. The Lex bot has an English (US) locale. A completed answer plays the goodbye from the table. An escalation, or any path that does not finish the question, checks `HarborRidge311-Hours` (America/Los_Angeles, Monday through Friday 08:00-17:00). During those hours the flow sets `HarborRidge311-EscalationGuide` as the agent UI, sets the `HarborRidge311-General` queue, and transfers to it. After hours, the contact goes to the voicemail flow. If the queue transfer fails or the queue is at capacity, the flow plays the goodbye prompt. A lookup error plays a hardcoded English fallback and hangs up. A test agent, `harborridge-agent1`, uses a softphone. The password is generated in Secrets Manager and only the secret ARN is published. A custom resource calls `AssociatePhoneNumberContactFlow` so the sandbox number uses this flow, and `DisassociatePhoneNumberContactFlow` when the stack is deleted.

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

Outputs are the contact flow ARN, the phone number, the sandbox assistant ARN, the Lex bot alias ARN, and the test agent password secret ARN.

## Touchpoint

`TouchpointStack` adds chat and a browser voice call to the static site. Both enter `HarborRidge311-Main`. Chat calls `StartChatContact`, so Connect sets the contact channel to `CHAT`. The browser call calls `StartWebRTCContact`, so the channel is `VOICE`. The flow's select-orchestrator Lambda reads that channel and picks the matching agent. The stack reads the sandbox instance the same way `ConnectStack` does, and reads the main flow id and ARN from `/connect/sandbox/harbor-ridge-311/main-contact-flow-id` and `main-contact-flow-arn`, which `ConnectStack` publishes. Deploy the site and the flow before the touchpoint stack, or deploy all three together:

```bash
npx cdk deploy WebsiteStack ConnectStack TouchpointStack
```

The page reads `config.js`, which the touchpoint stack writes into the site bucket at deploy time.

## Useful commands

* `npm run build`   type-check the project
* `npm run watch`   watch for changes and type-check
* `npm run test`    perform the jest unit tests
* `npx cdk deploy WebsiteStack`  deploy the static site
* `npx cdk deploy ConnectStack`  deploy the contact flow
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
* `pip install -r requirements-dev.txt && npm run cfn-lint`  lint the synthesized WebsiteStack, ConnectStack, and TouchpointStack templates
