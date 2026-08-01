# Customizing Sandboxes

The MicroVM sandbox is a [Cloudflare Container](https://developers.cloudflare.com/containers/) —
a Docker image running in a microVM with an instance size declared in `wrangler.jsonc`.
Both are easy to change, and a redeploy picks them up.

(Isolate sandboxes don't have an image or an instance type — they run
inside Workers Isolates. This page only covers MicroVM.)

## Customize the image

The image is built from the repo's `Dockerfile`, which extends the
[Cloudflare Sandbox base image](https://developers.cloudflare.com/sandbox/)
and installs the Anthropic `ant` CLI on `PATH`.

Add whatever your agents need. Languages, CLIs, internal tools — bake
them in once instead of having every session install them on first
use.

```dockerfile
# Dockerfile
FROM docker.io/cloudflare/sandbox:0.10.1

# Existing apt packages from the repo (curl, git, jq, ripgrep, …)

RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    redis-tools \
 && rm -rf /var/lib/apt/lists/*

# A specific Node version, an internal CLI, etc.
RUN curl -fsSL https://internal.example.com/tools/install.sh | bash

# … existing ant CLI install …
```

Two rules:

- **Don't override `ENTRYPOINT`.** The Sandbox SDK runtime listens on
  port 3000 inside the container; replacing the entrypoint kills it.
- **Don't drop the `ant` CLI install.** The Worker starts it via
  `sandbox.startProcess(...)` after the egress policy is attached.

After editing:

```sh
npm run deploy
```

`npm run deploy` rebuilds the image and ships it. The next session for
each agent picks up the new image.

## Customize the instance size

`wrangler.jsonc` declares the sandbox size and maximum number of concurrent instances:

```jsonc
"containers": [{
  "class_name": "Sandbox",
  "image": "./Dockerfile",
  "instance_type": "standard-1",
  "max_instances": 100
}]
```

* `instance_type` — the sandbox size (see [instance type docs](https://developers.cloudflare.com/containers/platform-details/instance-types/)).
* `max_instances` — caps concurrent instances to keep runaway costs in check.

Edit `wrangler.jsonc` and redeploy to apply changes.
