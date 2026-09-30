# Set up your own Inbound Parse server on a Mac Mini

This guide takes a blank Mac Mini to the point where a real email sent to your domain lands in this receiver's database. It's based on the first deployment, on a Mac Mini called the Owlery, in September 2026. Every gotcha listed here actually happened.

Plan on 60–90 minutes. Most of that is waiting on installs and DNS. You'll need to be at the Mini, with a monitor and keyboard, for about 15 minutes in Parts 1 and 3. Everything else can be done over SSH.

```
Sender ──MX──▶ SendGrid Inbound Parse ──HTTPS──▶ Tailscale Funnel ──▶ Mac Mini: Docker ──▶ SQLite + attachments
```

## Before you start

You need:

- **A Mac Mini** (Apple Silicon). We used macOS 26.5.
- **A laptop** to work from.
- **A Tailscale account.** Funnel works on the free plan.
- **A domain whose DNS you can edit.** We used Namecheap.
- **A SendGrid account** where you can authenticate that domain.
- **An email address on a domain in your allowlist,** to send test mail from (Part 5).

**Keep work credentials and internal company code off the Mini.** If it's a personal or otherwise unmanaged device, treat it as untrusted. It only needs this repo and the secrets in its `.env`: no internal repos, notes, or work tokens. This receiver lives in its own repo for exactly that reason.

Placeholders used below:

| Placeholder | Meaning | Example |
|---|---|---|
| `<mini-user>` | The Mini's local macOS account short name | `minibot` |
| `<mini-ip>` | The Mini's Tailscale IP (`100.x.y.z`) | from `tailscale status` |
| `<mini>.<tailnet>.ts.net` | The Mini's Funnel hostname | printed in Part 6 |
| `<yourdomain>` | Your domain | `example.com` |

## Part 1: Mac Mini basics (at the Mini)

1. **Create a single admin account** during macOS setup. Note its short name. That's your SSH username, and it's not your laptop username.
2. **Keep the Mini awake.** Go to **System Settings → Energy** and turn on the option that prevents automatic sleep. To check from Terminal, run `pmset -g | grep " sleep"`, which should show `0`.
3. **Restart after a power failure.** Run `sudo pmset -a autorestart 1`. Ours was set to `0`, which means that after an outage the Mini just stays off.
4. **Turn on Remote Login.** Go to **System Settings → General → Sharing → Remote Login** and allow your account.
5. **Turn on Screen Sharing** in the same Sharing pane. Click the ⓘ next to it and allow your account. Use this setting, not the command line.
   > **Gotcha:** Turning on sharing over SSH with `kickstart -activate` enables *Remote Management* instead. After that, VNC rejects your password and eventually shows "Screen Sharing is not permitted." If that already happened, run `sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart -deactivate -stop`. Then turn Screen Sharing off and back on in System Settings.
6. **Install Homebrew:**
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
7. **Fix PATH for SSH commands.** A command you run as `ssh host 'cmd'` reads `~/.zshenv`, not `~/.zprofile`. So Homebrew, Docker, and Tailscale all show `command not found` over SSH until you add this:
   ```bash
   cat >> ~/.zshenv <<'EOF'
   export PATH="$HOME/.docker/bin:/opt/homebrew/bin:/Applications/Tailscale.app/Contents/MacOS:$PATH"
   EOF
   ```
8. **FileVault.** Leave it on, since the Mini holds secrets. Know that after *any* restart the Mini waits at an unlock screen and nothing starts. Docker Desktop is an app, so it only runs once someone logs in. After a power loss, someone has to unlock the Mini at the machine. For planned reboots, use `sudo fdesetup authrestart`, which unlocks once on the way back up.

## Part 2: SSH from your laptop

1. **Install Tailscale on both machines** and sign in with the same account. On the laptop, `tailscale status` lists the Mini and its `100.x.y.z` IP.
2. **Copy your SSH key** to the Mini. You'll be asked for the Mini account's password once:
   ```bash
   ssh-copy-id <mini-user>@<mini-ip>
   ```
3. **Connect:**
   ```bash
   ssh <mini-user>@<mini-ip>
   ```

Gotchas:

- **Your corporate VPN drops when Tailscale connects.** In the laptop's Tailscale menu, turn off **Use Tailscale DNS** and make sure no exit node is selected. After that, the Mini's short name won't resolve from your laptop, so use its `100.x` IP.
- **`tailscale ssh` fails** with "No ED25519 host key is known … strict checking." Tailscale SSH isn't enabled on the Mini. Use plain `ssh`.
- **"Connection closed by … port 22" right after connecting** means you used the wrong username, or your key isn't on the Mini yet.
- **VNC hangs at "Connecting."** Run `nc -zv <mini-ip> 5900` from the laptop. If that fails, Screen Sharing is off (Part 1, step 5). To connect: **Finder → Go → Connect to Server** (⌘K in *Finder*; in Terminal, ⌘K clears the screen) → `vnc://<mini-ip>`.

## Part 3: Docker Desktop (at the Mini)

Do this in Terminal on the Mini itself, or over Screen Sharing. Over SSH, the install stops at `sudo: a terminal is required` and removes itself. Don't write a script that types your password for you. We tried an `expect` script, and it echoed the password to the screen in plain text.

1. Run `brew install --cask docker` and enter your password when asked.
2. Open **Docker** from Applications and accept the terms.
3. **Skip sign-in** by clicking **Continue without signing in**. This setup doesn't need a Docker account.
4. Wait for the whale icon in the menu bar to stop animating.
5. **Turn on auto-start:** **Docker Desktop → Settings → General → Start Docker Desktop when you sign in to your computer.** Ours was off. Without it, the receiver doesn't come back after a restart.
6. Check from your laptop:
   ```bash
   ssh <mini-user>@<mini-ip> 'docker version --format "{{.Server.Version}}"'
   ```

> **Gotcha:** Docker Desktop 4.93+ puts the `docker` command in `~/.docker/bin` and its socket at `~/.docker/run/docker.sock`. There's no `/usr/local/bin/docker` and no `/var/run/docker.sock`. That's normal, so don't try to fix it. Part 1, step 7 adds the right path.

## Part 4: Get the code onto the Mini

The repo is public, so clone it over HTTPS. The Mini doesn't need a GitHub account, token, or SSH key.

```bash
git clone https://github.com/owlery-lab/owlery-inbound-parse.git ~/owlery-inbound-parse
```

To update later, run `git pull` in that folder, then `docker compose up -d --build`.

If you run your own private fork, use a read-only **deploy key** instead of a personal token. That way the Mini can only read that one repo.

## Part 5: Configure and start the receiver

On the Mini:

```bash
cd ~/owlery-inbound-parse
cp .env.example .env
chmod 600 .env
openssl rand -base64 32 | tr -d '=+/' | cut -c1-32   # your Basic Auth password
```

Edit `.env`:

```bash
SENDGRID_INBOUND_BASIC_AUTH_USER=inbound
SENDGRID_INBOUND_BASIC_AUTH_PASS=<the generated password>
SENDGRID_INBOUND_ALLOWED_SENDER_DOMAINS=example.com
```

Replace `example.com` with the domain or domains you'll send test mail from, separated by commas. Only mail from those domains is saved.

Generate the password on the Mini and keep it there. Don't paste it into chat, Slack, or tickets. SendGrid is the only other place it goes, in Part 8.

Start the receiver and check it:

```bash
docker compose up -d --build
docker compose ps                 # "healthy" after about 30 seconds
curl http://localhost:3000/health # {"status":"ok","service":"owlery-inbound-parse"}

set -a; source .env; set +a
curl -u "inbound:$SENDGRID_INBOUND_BASIC_AUTH_PASS" \
  -F from=you@example.com -F subject=hi -F text=hello \
  http://localhost:3000/sendgrid/inbound      # {"ok":true,"id":1,...}
docker compose exec -T api bun src/cli.ts tail
```

Notes:

- The database and attachments live in `./data` on the Mini, which the container sees as `/data`. The tables are created automatically on first start.
- Leave `DB_PATH` and `INBOUND_ATTACHMENTS_DIR` unset in `.env` when you use Docker. The image already points them at `/data`. If you set `INBOUND_ATTACHMENTS_DIR=./data/...`, attachments end up inside the container and are lost when it's rebuilt.
- Inside the container, files in `/data` show as owned by `root`. That's just how Docker Desktop displays shared folders. On the Mac they belong to your account, and the server itself runs as the unprivileged `bun` user.
- If the build fails with a Bun error about `--production=false`, you have an old copy. Run `git pull`.

## Part 6: Make it reachable from the internet (Tailscale Funnel)

1. **Allow Funnel in your tailnet policy.** In the Tailscale admin console, go to **Access controls → JSON editor**. The visual Policies tab doesn't show Funnel. Add this at the top level, next to `"grants"`, and save:
   ```json
   "nodeAttrs": [
       {"target": ["autogroup:member"], "attr": ["funnel"]},
   ],
   ```
2. **Turn it on from the Mini.** No `sudo` needed:
   ```bash
   tailscale funnel --bg 3000
   ```
   The first time, it prints "Funnel is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/funnel?node=…". Open that link, approve, and run the command again. When it works, it prints `Available on the internet: https://<mini>.<tailnet>.ts.net/`. `--bg` saves the setting, so it survives restarts. Check with `tailscale funnel status`.
3. **Wait for public DNS.** Ours took well over five minutes:
   ```bash
   dig +short <mini>.<tailnet>.ts.net @8.8.8.8   # returns two IPs when ready
   ```
4. **Test from your laptop.** If the laptop is on the same tailnet, it may say "Could not resolve host" even once public DNS works. The laptop's Tailscale resolver doesn't answer for Funnel names. Skip it like this:
   ```bash
   IP=$(dig +short <mini>.<tailnet>.ts.net @8.8.8.8 | head -1)
   curl --resolve <mini>.<tailnet>.ts.net:443:$IP https://<mini>.<tailnet>.ts.net/health
   ```
   SendGrid uses public DNS, so it doesn't run into this.

## Part 7: DNS: send your subdomain's mail to SendGrid

Pick a subdomain, such as `owlery.<yourdomain>`. It needs exactly one record, an MX record.

**Namecheap:** Go to **Domain List → Manage → Advanced DNS**. Scroll to **Mail Settings** and choose **Custom MX**. You can't add MX records in the Host Records table. Add:

| Host | Value | Priority | TTL |
|---|---|---|---|
| `owlery` | `mx.sendgrid.net` | `10` | Automatic |

With other providers, create an MX record with the same values.

Gotchas:

- **Don't add a CNAME or A record for the subdomain.** A CNAME can't share a name with an MX record. We had a `parse` subdomain that was a CNAME to the root domain, and it never received a single email.
- **Use a subdomain, not the root domain,** so you don't take over mail the root domain already receives.

Check:

```bash
dig +short MX owlery.<yourdomain> @8.8.8.8   # 10 mx.sendgrid.net.
```

## Part 8: SendGrid

1. **Sign in.** For two-factor codes, use an authenticator app. We used Authy. Google Voice numbers often don't receive them.
2. **Authenticate the domain** under **Settings → Sender Authentication → Authenticate Your Domain**. SendGrid gives you three CNAME records to add (`em####`, `s1._domainkey`, `s2._domainkey`). Only authenticated domains show up in the Inbound Parse domain list. If those CNAMEs are already in your DNS, this step is done.
3. **Add the route** under **Settings → Inbound Parse → Add Host & URL**:
   - **Subdomain:** `owlery`. **Domain:** pick yours from the list.
   - **Destination URL:** `https://inbound:<password>@<mini>.<tailnet>.ts.net/sendgrid/inbound`. The host is your **Funnel hostname**, not your mail subdomain. To see the password, run `grep BASIC_AUTH_PASS ~/owlery-inbound-parse/.env` on the Mini.
   - **Check incoming emails for spam:** on.
   - **POST the raw, full MIME message:** off.

## Part 9: The first real email

From an address on your allowlist, send an email to `anything@owlery.<yourdomain>`. It usually arrives within seconds. On the Mini:

```bash
cd ~/owlery-inbound-parse
docker compose exec -T api bun src/cli.ts tail
docker compose exec -T api bun src/cli.ts show <id>
ls data/inbound-parse/        # one folder per email that had attachments
```

**Mail from a domain that isn't allowlisted is dropped on purpose,** so it won't appear. To test from a personal address, temporarily add its domain to `SENDGRID_INBOUND_ALLOWED_SENDER_DOMAINS`, run `docker compose up -d --force-recreate api`, and remove it again afterward.

## Part 10: Keep it running

**After any restart,** the sequence is: unlock FileVault and log in → Docker Desktop starts (if auto-start is on) → the container restarts on its own → Funnel comes back on its own. To check:

```bash
docker compose ps
tailscale funnel status
```

**Daily PII purge.** This deletes the contents and attachments of emails older than 30 days, and keeps a record that each email arrived. The launchd job below hasn't been installed on the Owlery yet, so test it before you rely on it. Save it as `~/Library/LaunchAgents/dev.owlery.inbound-purge.plist`, replacing `<mini-user>`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.owlery.inbound-purge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>cd /Users/&lt;mini-user&gt;/owlery-inbound-parse &amp;&amp; /Users/&lt;mini-user&gt;/.docker/bin/docker compose --profile cron run --rm inbound-purge</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>17</integer></dict>
  <key>StandardOutPath</key><string>/tmp/inbound-purge.out</string>
  <key>StandardErrorPath</key><string>/tmp/inbound-purge.err</string>
</dict>
</plist>
```

Load it and run it once to test:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.owlery.inbound-purge.plist
launchctl kickstart gui/$(id -u)/dev.owlery.inbound-purge
cat /tmp/inbound-purge.out /tmp/inbound-purge.err
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `command not found: docker` (or `brew`, `tailscale`) over SSH | `~/.zshenv` isn't set up | Part 1, step 7 |
| `sudo: a terminal is required` during the Docker install | You ran it over SSH | Run it at the Mini (Part 3) |
| `Connection closed by <ip> port 22` | Wrong username, or key not copied | Use the Mini's account name; run `ssh-copy-id` |
| `No ED25519 host key is known` from `tailscale ssh` | Tailscale SSH is off on the Mini | Use plain `ssh` |
| Corporate VPN drops when Tailscale connects | Tailscale DNS on the laptop | Turn off **Use Tailscale DNS**; use the `100.x` IP |
| VNC stuck at "Connecting" | Screen Sharing is off | Part 1, step 5; check with `nc -zv <mini-ip> 5900` |
| "Screen Sharing is not permitted" | Remote Management was turned on with `kickstart` | Turn it off; toggle Screen Sharing in System Settings |
| `Funnel is not enabled on your tailnet` | Tailnet-level Funnel not approved | Open the link it prints |
| `Could not resolve host …ts.net` from the laptop | DNS still spreading, or the laptop's Tailscale resolver | Check with `dig @8.8.8.8`; use `curl --resolve` |
| Email sent, nothing in `tail` | MX, SendGrid route, allowlist, or password | `dig MX`; check the Inbound Parse entry; `docker compose logs api \| grep -E "rejected\|auth"` |
| Receiver down after a restart | FileVault not unlocked, or Docker auto-start off | Log in at the Mini; Part 3, step 5 |
| Attachments missing after a rebuild | `INBOUND_ATTACHMENTS_DIR` points outside `/data` | Remove it from `.env` (Part 5) |

In the logs, `Webhook auth rejected` means SendGrid's password doesn't match `.env`. `sender domain not allowlisted` means the allowlist dropped the email.
