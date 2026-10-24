# Harbor Ridge 311

Portfolio demo of a fictional city 311 line. `WebsiteStack` is the static site. `ConnectStack` is the phone demo on the existing Amazon Connect sandbox instance.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Website

`website/` is its own npm package. Vite and `@amazon-connect-touchpoint/web` live there, not in the CDK app. Root `npm ci` installs the CDK app, then installs the site package. To install the site package alone, run `npm ci --prefix website`. Synth, tests, and deploy need that install. If `website/node_modules` is missing, the site build stops and tells you to run that command.

`WebsiteStack` builds `website/` with Vite when the stack is synthesized, then deploys that output to a private S3 bucket behind CloudFront. The built page loads `/config.js` as a classic script and loads the page module separately. The module is deferred, so `/config.js` runs first. `TouchpointStack` writes `config.js` into the same bucket at deploy time. The HTML deployment excludes `config.js` and `assets/*`, so its prune does not delete those objects. `index.html` and `404.html` are deployed with `Cache-Control: no-cache`. Hashed files deploy under the `assets` prefix with `Cache-Control: public, max-age=31536000, immutable`. That deployment only prunes inside the prefix. The HTML deployment invalidates `/*` after the assets upload.

`npm run build` type-checks the CDK app and builds the site. `npm run build:site` builds only the site.

## ConnectStack

`ConnectStack` reads the sandbox instance published by [connect-platform](https://github.com/ckreidler/connect-platform) and adds a contact flow named `HarborRidge311-Main` plus a data table named `HarborRidge311-PromptsByChannel`. The flow is English only. It sets the Joanna voice, then plays the greeting from the table. The caller can ask about trash pickup, potholes, parking permits, or office hours. Answers come from two Amazon Q in Connect orchestration agents, one for voice and one for chat, using FAQ documents in a private S3 bucket. The Lex bot has an English (US) locale. A completed answer plays the goodbye from the table. An escalation, or any path that does not finish the question, checks `HarborRidge311-Hours` (America/Los_Angeles, Monday through Friday 08:00-17:00). During those hours the flow sets `HarborRidge311-EscalationGuide` as the agent UI, sets the `HarborRidge311-General` queue, and transfers to it. After hours, the flow opens a Harbor Ridge 311 ticket from the escalation summary, tells the customer the ticket number, and disconnects. If that ticket step fails, it plays a closed message and disconnects. If the queue transfer fails or the queue is at capacity, the flow plays the goodbye prompt. A lookup error plays a hardcoded English fallback and hangs up. A test agent, `harborridge-agent1`, uses a softphone. The password is generated in Secrets Manager and only the secret ARN is published. A custom resource calls `AssociatePhoneNumberContactFlow` so the sandbox number uses this flow, and `DisassociatePhoneNumberContactFlow` when the stack is deleted.

The [HarborRidge311-Main](docs/flows/HarborRidge311-Main.md), [HarborRidge311-Queue](docs/flows/HarborRidge311-Queue.md), and [HarborRidge311-EscalationGuide](docs/flows/HarborRidge311-EscalationGuide.md) diagrams are generated from the flow builder.

The Q in Connect assistant is owned by connect-platform. This stack reads that assistant and associates the Harbor Ridge FAQ knowledge base and the Lex bot with the shared sandbox instance.

SSM parameters, read at deploy time with `StringParameter.valueForStringParameter`:

- `/connect/sandbox/instance-arn`
- `/connect/sandbox/instance-id`
- `/connect/sandbox/phone-number-arn`
- `/connect/sandbox/phone-number`
- `/connect/sandbox/assistant-arn`
- `/connect/sandbox/assistant-id`

Tickets live in this stack. A DynamoDB table stores them, an IAM-authenticated API Gateway fronts one Lambda, and an Amazon Bedrock AgentCore Gateway exposes that API as MCP tools. The orchestration security profile can call those tools. A phone call matches the ANI to a Customer Profile and can open, check, update, and close that profile's tickets. Chat can open a ticket on a profile created for that contact, and cannot check or change one. After hours, the flow invokes the ticket Lambda directly and speaks the new ticket id.

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

* `npm run build`   type-check the project and build the site
* `npm run build:site`  build the static site with Vite
* `npm run watch`   watch for changes and type-check
* `npm run test`    perform the jest unit tests
* `npm run diagrams`  regenerate `docs/flows` from the flow builder
* `npx cdk deploy WebsiteStack`  deploy the static site
* `npx cdk deploy ConnectStack`  deploy the contact flow
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
* `pip install -r requirements-dev.txt && npm run cfn-lint`  lint the synthesized WebsiteStack, ConnectStack, and TouchpointStack templates
