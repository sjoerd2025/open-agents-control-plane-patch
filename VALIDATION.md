## Validation

You should be able to do the following things.

### Setup
- When I set up the environment without the correct environment variables, I am properly warned and instructed on next steps
- When I need to run a migration, I am properly warned and instructed on next steps
- When I deploy via Workers Builds, there is a predeploy step that migrates for me
- I can use the Deploy to Cloudflare button. It has the right things parameterized
- Nothing is hardcoded in wrangler config or the codebase that should not be
- I can get onboarded and understand what is happening as I set this up
- I can read the README and understand why I would use this, how to run it, and how to extend it in the future
- I am presented with relevant links to the Claude Managed Agents platform

- If the proper environment variables are in place and no Agent exists, the user should see a banner that prompts them to create their first Agent (with a link)

- If VPC is configured, I can access VPC endpoints
- If VPC is not configured, I cannot access VPC endpoints

- If Browser Run is configured, I can configure browser tools
- If Browser Run is not configured, I cannot configure browser tools

- If email is configured, I can configure email tools
- If email is not configured, I cannot configure email tools

### Documentation
- The Readme is accurate
- The Readme explains all of the steps necessary to get started
- The Readme explains the utility of this environment and template
- The Readme includes a brief explanation of how things work so the user can put the pieces together in their head
- The documentation linked to in the Readme and the UI is accurate and up-to-date

### UI
- Where possible, links to the Claude Managed Agents platform are provided
- Where possible, links to the Cloudflare dashboard are provided
- Where possible, cross-links to other parts of this UI are provided to make navigation simpler

### CRUD
- I can create a VM-based sandbox
  - With no tools
  - With Anthropic's tools
  - With custom tools defined
  - A system prompt is automatically added to the agent that can be modified. It has all the relevant information for the VM agent.

- If can create an isolate-based sandbox
  - With no tools
  - With Anthropic's tools
  - With custom tools defined
  - A system prompt is automatically added to the agent that can be modified. It has all the relevant information for the Isolate-based agent.

- I can create and delete secrets

### Basic Functionality

- I can run a VM-based sandbox properly in response to a Claude Agent
- I can run an isolate-based sandbox properly in response to a Claude Agent
- Webhooks from Claude are properly delivered

- I can resume a Claude Agent in the future and have it pick up where it left off
  - Files from a previous run is automatically restored
  - If I am missing environment variables to do this, it is clearly shown and I am prompted to fix this

### Egress and Security

- I can create, update, and delete egress policies

- Allow lists work properly
- Deny lists work properly
- I can inject credentials in headers on egress on certain routes
- I can access a VPC endpoint via an egress proxy
- I can run arbitrary proxy middleware via an egres proxy

- When setting up an egress policy, if it is marked as applying to all sandboxes, it is applied to all sandboxes
- When setting up an egress policy, if it is marked as applying to a specific sandbox based on ID, it is only applied to that sandbox (test positive and negative cases)
- When setting up an egress policy, if it is marked as applying to a specific agent's sandbox, it is only applied to that agent's sandbox
- All the operators for matching to specific attributes work correctly

- Egress policies are well-explained in the documentation

### Tools

#### Browser Tools

- I can run a web_fetch equivalent on CF infrastructure using a tool
- I can screenshot a page using a browser tool
- I can fetch a page and convert it to markdown using a browser tool
- I can generically control a browser using a browser tool

#### VPC Tool
- I can set up Workers VPC or Mesh to a specific destination then access that destination using a tool
- In the readme, there is an example of setting up a VPC endpoint, such as a local tunnel to your laptop. It is clearly explained how to do this, and I can quickly validare the VPC integration this way.
- I am linked to the appropriate documentation for setting this up on real infrastructure

#### Header Injection Tool
- I can set up header injection on a specific endpoint, then access that endpoint using a tool
  - I cannot access the header's value from the agent

#### Email tool
- I can send emails using the email tool
- I can send emails to an Agent session and kick off work in response

#### Workers AI Tool
- If the Workers AI tool is not configured, it is not available
- If the Workers AI tool is configured, it is available
- This tools works to generate an image that can be used by an Agent

#### Custom Tools
- It is extremly simple to add a new custom tool
  - The documentation points me to a single spot to add the new tool
  - I have to write very little code to add it
  - I can then apply it to new agents, both Isolate and VM based
