#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings } from "./core/config.js";
import { AuthRequiredError, OAuthError, ProjectError } from "./core/errors.js";
import { AntigravityClient } from "./providers/antigravity/client.js";
import { ChatgptClient } from "./providers/chatgpt/client.js";
import { accountIdOf, isExpired, projectOf } from "./providers/antigravity/tokens.js";
import { startServer } from "./server.js";

function usage() {
  console.log(`Usage: node src/cli.js <command>

Commands:
  login                      Sign in with Google Antigravity. Adds another account.
  login-chatgpt              Sign in with ChatGPT / Codex. Adds another account.
  logout [email]             Remove one Antigravity account, or all if omitted
  logout-chatgpt [email]     Remove one ChatGPT account, or all if omitted
  use <email>                Make that saved Antigravity account active
  status                     Show every saved account
  models                     List models (live + static)
  serve [--host H] [--port N]
                              Dashboard: http://HOST:PORT/
`);
}

function parseServe(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--host") out.host = argv[++i];
    else if (argv[i] === "--port") out.port = Number(argv[++i]);
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    usage();
    process.exit(command ? 0 : 2);
  }
  const settings = loadSettings(command === "serve" ? parseServe(rest) : {});
  const client = new AntigravityClient(settings);
  const chatgpt = new ChatgptClient(settings);

  if (command === "login") {
    try {
      const existing = client.accounts();
      if (existing.length) {
        console.log(`Already have ${existing.length} saved account(s). Sign in with the other Google account in the browser.`);
      }
      const bundle = await client.login();
      console.log(`Logged in as ${bundle.email || "unknown"}`);
      console.log(`Project: ${projectOf(bundle) || "(none yet)"}`);
      console.log(`Accounts saved: ${client.accounts().length}`);
      console.log(`Tokens saved to ${client.store.path}`);
      return 0;
    } catch (err) {
      if (err instanceof OAuthError || err instanceof ProjectError) {
        console.error(`login failed: ${err.message}`);
        return 1;
      }
      throw err;
    }
  }

  if (command === "login-chatgpt") {
    try {
      const existing = chatgpt.accounts();
      if (existing.length) {
        console.log(`Already have ${existing.length} saved ChatGPT account(s). Sign in with the other OpenAI account in the browser.`);
      }
      const bundle = await chatgpt.login();
      console.log(`Logged in as ${bundle.email || "unknown"}`);
      console.log(`Plan: ${bundle.plan || "(unknown)"}`);
      console.log(`Accounts saved: ${chatgpt.accounts().length}`);
      console.log(`Tokens saved to ${chatgpt.store.path}`);
      return 0;
    } catch (err) {
      if (err instanceof OAuthError) {
        console.error(`login-chatgpt failed: ${err.message}`);
        return 1;
      }
      throw err;
    }
  }

  if (command === "logout-chatgpt") {
    const target = rest[0];
    if (!target) {
      chatgpt.store.clear();
      console.log("Removed all saved ChatGPT accounts.");
      return 0;
    }
    try {
      await chatgpt.removeAccount(target);
      console.log(`Removed ${target}`);
      return 0;
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }
  }

  if (command === "logout") {
    const target = rest[0];
    if (!target) {
      client.store.clear();
      console.log("Removed all saved accounts.");
      return 0;
    }
    try {
      await client.removeAccount(target);
      console.log(`Removed ${target}`);
      return 0;
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }
  }

  if (command === "use") {
    const target = rest[0];
    if (!target) {
      console.error("usage: node src/cli.js use <email>");
      return 2;
    }
    try {
      const bundle = await client.switchAccount(target);
      console.log(`Active account: ${bundle.email || accountIdOf(bundle)}`);
      return 0;
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }
  }

  if (command === "status") {
    const accounts = client.accounts();
    const chatgptAccounts = chatgpt.accounts();
    if (!accounts.length && !chatgptAccounts.length) {
      console.log("Not logged in. Run: node src/cli.js login   or   node src/cli.js login-chatgpt");
      return 1;
    }
    if (accounts.length) {
      const active = client.activeAccount();
      console.log(`antigravity: ${client.baseUrl}`);
      console.log(`accounts: ${accounts.length}`);
      for (const bundle of accounts) {
        const summary = client.accountSummary(bundle);
        const mark = summary.active ? "*" : " ";
        const bits = [
          `${mark} ${summary.email || summary.id}`,
          `project=${summary.project || "?"}`,
          `expired=${isExpired(bundle)}`,
        ];
        if (summary.enabled === false) bits.push("disabled");
        if (summary.limited) bits.push(`limited_until=${new Date(summary.disabled_until).toISOString()}`);
        if (summary.quotas?.length) {
          bits.push(
            "quotas=" +
              summary.quotas
                .map((q) => `${q.window}:${q.remaining == null ? "?" : Math.round(q.remaining * 100) + "%"}`)
                .join(","),
          );
        }
        console.log(bits.join("  "));
      }
      if (active) console.log(`active: ${active.email || accountIdOf(active)}`);
    }
    if (chatgptAccounts.length) {
      const active = chatgpt.activeAccount();
      console.log(`chatgpt: ${chatgpt.baseUrl}`);
      console.log(`chatgpt accounts: ${chatgptAccounts.length}`);
      for (const bundle of chatgptAccounts) {
        const summary = chatgpt.accountSummary(bundle);
        const mark = summary.active ? "*" : " ";
        const bits = [
          `${mark} ${summary.email || summary.id}`,
          `plan=${summary.plan || "?"}`,
          `expired=${isExpired(bundle)}`,
        ];
        if (summary.enabled === false) bits.push("disabled");
        if (summary.limited) bits.push(`limited_until=${new Date(summary.disabled_until).toISOString()}`);
        if (summary.quotas?.length) {
          bits.push(
            "quotas=" +
              summary.quotas
                .map((q) => `${q.window}:${q.remaining == null ? "?" : Math.round(q.remaining * 100) + "%"}`)
                .join(","),
          );
        }
        console.log(bits.join("  "));
      }
      if (active) console.log(`chatgpt active: ${active.email || accountIdOf(active)}`);
    }
    return 0;
  }

  if (command === "models") {
    const [antigravityModels, chatgptModels] = await Promise.all([
      client.fetchModels().catch(() => []),
      chatgpt.fetchModels().catch(() => []),
    ]);
    const models = [...chatgptModels, ...antigravityModels];
    console.log(JSON.stringify(models.map((m) => ({ id: m.id, name: m.name, family: m.family, source: m.source, quota: m.remaining_fraction })), null, 2));
    return 0;
  }

  if (command === "serve") {
    await startServer({ settings, client, chatgpt });
    return new Promise(() => {});
  }

  usage();
  return 2;
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  main().then(
    (code) => {
      if (typeof code === "number") process.exit(code);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

export { main };
