---
packages:
  padrone: minor
---

## Env variables in help

`padroneEnv({ vars: { port: 'APP_PORT' } })` maps args to environment variables without a schema. Values are coerced by the command's schema, and each option's variables are shown in help as `Env: APP_PORT`. Interceptors can declare the variables they read via `meta.env`.
