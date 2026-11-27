# One Connect from the CLI

Two separate jobs: adding One Connect to an app the user is building, and running this CLI as one of that app's users.

## Adding One Connect to an App

When the user is building an app whose own users should connect their tools (Gmail, Stripe, Slack...) to it, that is One Connect, not this CLI's connections. Install its skill inside the app, then follow it:

```bash
one --agent skills add connect      # from the @withone/connect version the app installed; latest from npm otherwise
```

It lands in `.agents/skills/one-connect` (and `.claude/skills/one-connect`). Outside a project (a folder with `package.json` or `.git`) it errors unless you pass `--global`. The result's `next` array says what to do; the skill covers the button, the two routes, key mode vs token mode, and calling One with the grant. Never ask the user to paste the client secret or connect key into chat.

To create the Connect app itself without the dashboard, install `@withone/connect` in the project (0.20.0 or later; the file imports it from there, not from the CLI), write `one.connect.ts` with `defineConnectApp` from `@withone/connect/config` (name, `redirectUris`, `ask` per tool with `access`: `read-only`, `read-write`, `full-access`, or `custom` with `actions`), then:

```bash
one --agent connect types      # tool slugs and action names autocomplete in one.connect.ts
one --agent connect create     # the human approves it in the browser; then writes ONE_CLIENT_ID, ONE_REDIRECT_URI and (for a list of tools) ONE_PERMISSION_SET to .env.local (or .env)
```

It opens a setup page in the human's browser and waits up to 10 minutes, so run it in the background or with a long timeout; the link is printed to stderr at once, so pass it on if no browser opened. The human reviews the app (or, on a re-run, its new version) and approves it with their dashboard session: an API key never creates or changes a Connect app. For a new app the page also makes `ONE_CLIENT_SECRET` and `ONE_CONNECT_KEY` and shows them once; the CLI adds empty lines for both to the env file, so tell the human to paste the values into the file the result names. The CLI never receives either secret. Run `connect create` again after editing the file to update the same app. It takes `--config <file>`, `--env-file <file>` and `--no-open` (print the link instead of opening it), and returns `{outcome, clientId, permissionSetId, asksForEverything, redirectUris, envFile}`. `ask` is required: the tools the app asks for, or `"everything"` (users see every connection they have and can connect any other app; the CLI then removes `ONE_PERMISSION_SET` from the env file).

## Acting for a Connect user

With `ONE_SECRET` set to an app's Connect key and `ONE_CONNECT_USER_ID` to the value the SDK stored for one of its users (`cu_…`, plus `;org=<id>;project=<id>` when they granted from an organization or project; env or `.onerc`), every call runs under the grant that user gave the app. `one --agent whoami` then includes `connectUserId`, `connection list` shows only what the grant reaches, `actions find` offers only actions inside it, and `actions execute` refuses one outside it with a 403, whose error reads "One refused this for the Connect user: it is outside the grant…". Plan from `list` and `find`: `actions load` reads docs by id whether or not the grant reaches the action. Adding connections and relays need an ordinary key.
