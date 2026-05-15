# Commit Signing

All commits to this repo should be SSH-signed. After setup, your commits show a green **Verified** badge on GitHub.com and `git log --show-signature` reports `Good "git" signature` locally.

## Setup

Run on macOS or Linux (Windows: use WSL or Git-Bash). Steps assume you already have a GitHub account with access to this repo.

> **Note:** Commit signing is independent of how you push. The SSH key generated below is used only for *signing* — your `origin` URL can be `https://github.com/...` or `git@github.com:...` and the steps are identical. If you push via HTTPS, see [If you push via HTTPS](#if-you-push-via-https-windows-or-linux) below for auth setup notes.

```bash
# 1. Make sure you have an ed25519 SSH key. Reuse your existing one if you do.
ls ~/.ssh/*.pub 2>/dev/null
# If empty, generate one:
ssh-keygen -t ed25519 -C "$(git config --global user.email)"
# (accept the default path; passphrase optional but recommended)

# 2. Configure git to sign commits & tags with that key
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
git config --global tag.gpgsign true

# 3. Set up allowed_signers so `git log --show-signature` verifies locally
mkdir -p ~/.config/git
git config --global gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers
printf '%s %s\n' \
  "$(git config --global user.email)" \
  "$(awk '{print $1, $2}' ~/.ssh/id_ed25519.pub)" \
  >> ~/.config/git/allowed_signers

# 4. Verify locally with a throwaway commit (no repo touched)
TMPDIR=$(mktemp -d) && (cd "$TMPDIR" && git init -q && \
  git commit --allow-empty -m "signing-test" -q && \
  git log --show-signature -1) && rm -rf "$TMPDIR"
# Expect: a line starting with `Good "git" signature for <your email>`

# 5. Print your public key — you'll paste this into GitHub next
cat ~/.ssh/id_ed25519.pub
```

## GitHub configuration (one-time, in the browser)

GitHub stores **authentication keys** and **signing keys** as separate entries. Even if your key is already registered for SSH login, you must register it again as a signing key.

1. **Add the SSH key as a Signing Key**
   - Open <https://github.com/settings/ssh/new>
   - **Title**: `<your-laptop-name> signing key`
   - **Key type**: **Signing Key** (the dropdown — *not* "Authentication Key")
   - **Key**: paste the line printed by step 5 above
   - Click **Add SSH key**
   - **Verify it landed in the right section**: open <https://github.com/settings/keys> and confirm your new key appears under **SSH signing keys**, not **SSH keys**. If it shows up under the wrong heading, you selected the wrong key type — delete it and re-add.

2. **Verify your commit email is registered and verified on your GitHub account**
   - Open <https://github.com/settings/emails>
   - The email shown by `git config --global user.email` must appear here with no "Unverified" label.
   - If it's missing, click **Add email address**, enter it, then click the verification link sent to that inbox.

   *Skipping this step is the most common mistake.* Without it, GitHub returns `reason: no_user` for your signed commits — they sign correctly but show as "Unverified" on GitHub.com.

## If you push via HTTPS (Windows or Linux)

The signing setup above is **the same** whether you push via SSH or HTTPS — the SSH key on disk is used only to sign. This section covers HTTPS push authentication, which is a separate concern from signing.

If `git push` already works for you via HTTPS (you have a credential manager, `gh auth login` cached, or a PAT in your config), nothing else is needed — your next signed commit will push and verify normally.

If you don't yet have HTTPS auth set up, pick one of:

**Option A — GitHub CLI (recommended):**

```bash
# Linux (Debian/Ubuntu):
#   sudo apt install gh
# Linux (Fedora/RHEL):
#   sudo dnf install gh
# Windows:
#   winget install --id GitHub.cli
#   or: choco install gh

gh auth login -p https -h github.com
# Choose: Login with a web browser → follow the device-code flow.
# When asked "Authenticate Git with your GitHub credentials?", answer Yes.
```

`gh auth login` writes a token into Git's credential helper, so subsequent `git push` calls reuse it without prompting.

**Option B — Personal access token + credential helper:**

1. Create a fine-grained PAT at <https://github.com/settings/personal-access-tokens> with at least **Contents: Read and write** for the repo(s) you'll push to.

2. Cache it via a credential helper:

   - **Linux / Git Bash on Windows:**
     ```bash
     git config --global credential.helper store
     ```
     The first `git push` after this prompts for username (your GitHub login) and password (paste the PAT). The helper stores it for future pushes.

   - **Windows native (PowerShell or CMD):** [Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager) is bundled with Git for Windows and configured by default. The first `git push` opens a browser window for OAuth; no manual PAT needed unless you prefer.

### Verify HTTPS push works before adding signing

If you're new to HTTPS push, confirm auth works on its own first:

```bash
# Clone via HTTPS:
git clone https://github.com/<owner>/<repo>.git
cd <repo>
# Make a trivial change, commit (signing not yet required for this test), and push:
git commit --allow-empty -m "https-push-test"
git push
# If this succeeds without an auth prompt, HTTPS push is ready.
# Now proceed with the signing setup above.
```

### Windows path notes

The Bash commands in this guide use `~/.ssh/id_ed25519.pub` and `~/.config/git/allowed_signers`. These resolve correctly inside **Git Bash** and **WSL**. If you're running PowerShell directly, either:

- Run the setup from Git Bash instead (simplest), or
- Substitute `$env:USERPROFILE\.ssh\id_ed25519.pub` and `$env:USERPROFILE\.config\git\allowed_signers` for the `~/...` paths, and translate `mkdir -p` to `New-Item -ItemType Directory -Force <path> | Out-Null`.

The signing config commands (`git config --global ...`) work identically in any shell.

## Verifying it worked

After your next pushed commit:

```bash
SHA=$(git rev-parse HEAD)
gh api "repos/<owner>/<repo>/commits/${SHA}" --jq '.commit.verification.verified'
# Expect: true
```

Or just look at the commit on GitHub.com — it should show a green **Verified** badge.

## Common gotchas

| Symptom | Cause | Fix |
|---|---|---|
| GitHub shows "Unverified", API returns `reason: no_user` | Commit's email isn't a verified email on your GitHub account | Add it at <https://github.com/settings/emails> |
| GitHub shows "Unverified", API returns `reason: unsigned` | `commit.gpgsign` not enabled, or git installed in a way that ignores global config | Re-run step 2; check `git config --global commit.gpgsign` returns `true` |
| Local `git log --show-signature` says "No principal matched" | Email in `user.email` doesn't match any line in `~/.config/git/allowed_signers` | Re-run step 3, or add a second line for the missing email |
| Passphrase prompt on every commit (macOS) | SSH agent not loaded with the key | `ssh-add --apple-use-keychain ~/.ssh/id_ed25519` |
| Passphrase prompt on every commit (Linux) | `ssh-agent` not running for the session | `eval "$(ssh-agent -s)" && ssh-add ~/.ssh/id_ed25519` |
| Already use 1Password as SSH agent | Same key can sign | Skip step 1; in step 2 set `user.signingkey` to the public key copied from the 1Password SSH key entry |
| Was previously using GPG signing | `gpg.format ssh` overrides GPG | Both can stay registered on GitHub; only the active `gpg.format` matters |
