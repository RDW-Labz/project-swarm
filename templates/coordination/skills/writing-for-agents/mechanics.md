# Skill mechanics

## Invocation

Choose between model-invoked and user-invoked skills. A model-invoked skill keeps a `description` so the agent can discover it autonomously; the description is always-loaded context. A user-invoked skill sets `disable-model-invocation: true`, has no description available to the agent, and relies on the human to remember it. Use model invocation only when autonomous discovery or another skill needs it.

## Splitting and routers

Split a model-invoked skill when it has a distinct trigger word or another skill must reach it. When user-invoked skills multiply, one user-invoked router can name them and when to use each. A router can hint at skills but cannot invoke them.
