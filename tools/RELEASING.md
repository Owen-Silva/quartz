# Cutting a Quartz release

Quartz's in-app updater (`updater.js`) offers whatever GitHub calls the **latest release** of
`Owen-Silva/quartz`. A release is a tag named `v<version>` (the `version` in `package.json`) on the
default branch, plus a GitHub release for that tag. Drafts and pre-releases are never "latest",
so the updater never sees them.

1. Start from a clean, pushed default branch:

   ```
   git switch master
   git pull --ff-only
   git status
   ```

2. Bump the version in `package.json` and `package-lock.json`, commit and push:

   ```
   npm version 0.2.0 --no-git-tag-version
   git commit -am "Quartz 0.2.0"
   git push origin master
   ```

   A version bump on its own does not make users run `npm ci`; the updater only runs it when the
   dependencies themselves change.

3. Tag that commit and publish the release (the notes are what users see behind "What's new"):

   ```
   git tag v0.2.0
   git push origin v0.2.0
   gh release create v0.2.0 --verify-tag --title "Quartz 0.2.0" --notes-file notes.md
   ```

   `--generate-notes` instead of `--notes-file` lists the commits since the last release.

4. Check what the updater will see:

   ```
   gh api repos/Owen-Silva/quartz/releases/latest --jq .tag_name
   ```

Rules that keep updates safe:

- The tag must be on the default branch, so every user's clone can fast-forward to it.
- Never move or delete a published tag. If a release is wrong, publish a newer one.
- To try a release without offering it to anyone, create it with `--draft` or `--prerelease`.
